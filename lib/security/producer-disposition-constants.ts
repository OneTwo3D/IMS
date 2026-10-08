/**
 * THE ONE PLACE THE PRODUCER-SIDE HOLD'S WORDS AND NAMES LIVE.
 *
 * The outbound-write hold (outbound-write-hold-constants.ts) refuses a request at the HTTP boundary.
 * The producer-side hold decides, one step earlier, whether a piece of IMS work should be QUEUED FOR
 * DELIVERY at all or only RECORDED AS A SHADOW (what IMS would have written, never delivered). This
 * module carries the environment variable names, the formats, the reason texts and the documentation
 * blocks of that decision. lib/security/producer-disposition.ts imports them; docs/installation.md
 * carries marked blocks whose body must equal the text below byte for byte, and
 * tests/security/producer-disposition-docs.test.ts checks EVERY marked block against this module.
 *
 * No dependency beyond the grant names: the decision, the tests and the docs check all import this and
 * none of them should need a database to read a sentence.
 */

import {
  OUTBOUND_CONNECTORS,
  OUTBOUND_CONNECTOR_LABEL,
  OUTBOUND_GRANT_ENV,
  type OutboundConnector,
} from './outbound-write-hold-constants'

/** Where an installation is in the programme, derived per destination (never a setting of its own). */
export type InstallationPhase = 'P0' | 'P1' | 'P2'

/**
 * The instant from which IMS writers may produce LIVE work for a destination, one variable per
 * destination. Environment only, like the grants, so a restored backup or a clone never inherits one.
 */
export const PRODUCER_CUTOFF_ENV: Record<OutboundConnector, string> = {
  xero: 'XERO_WRITES_LIVE_FROM',
  mintsoft: 'MINTSOFT_WRITES_LIVE_FROM',
  woocommerce: 'WC_WRITES_LIVE_FROM',
}

export const PRODUCER_CUTOFF_FORMAT = 'one UTC instant in ISO-8601 with an explicit Z, for example 2026-12-01T00:00:00Z'

/** Why a unit of work is shadowed. `live` is the only reason that is not a shadow. */
export const PRODUCER_REASONS = [
  'live',
  'no_grant',
  'unreadable_grant',
  'no_cutoff',
  'unreadable_cutoff',
  'before_cutoff',
  'not_ims_owned',
  'owner_unknown',
  'unreadable_obligation',
  'obligation_time_required',
  'obligation_before_cutoff',
  'unreadable',
] as const
export type ProducerReason = (typeof PRODUCER_REASONS)[number]

export const PRODUCER_REASON_TEXT: Record<ProducerReason, string> = {
  live: 'this installation may write this operation now',
  no_grant: 'the outbound-write grant for this destination is not set',
  unreadable_grant: 'the outbound-write grant for this destination is set but cannot be read',
  no_cutoff: 'the live-from instant for this destination is not set',
  unreadable_cutoff: 'the live-from instant for this destination is set but is not one UTC instant in ISO-8601 with an explicit Z',
  before_cutoff: 'the live-from instant for this destination has not been reached yet',
  not_ims_owned: 'another writer owns this operation in the current phase',
  owner_unknown: 'who owns this operation in the current phase has not been established',
  unreadable_obligation: 'the business-event time of this work could not be read',
  obligation_time_required: 'this operation needs the time of its business event and the producer did not supply it',
  obligation_before_cutoff: 'the business event happened before the live-from instant, so it belongs to the writer that owned it then',
  unreadable: 'the decision could not be evaluated',
}

/** The state of the agreement between a destination's grant and its live-from instant. */
export const PRODUCER_AGREEMENT_STATES = ['agreed_held', 'agreed_live', 'inconsistent', 'unreadable'] as const
export type ProducerAgreementState = (typeof PRODUCER_AGREEMENT_STATES)[number]

export function producerAgreementText(connector: OutboundConnector, detail: 'cutoff_without_grant' | 'grant_without_cutoff' | 'unreadable' | 'agreed_held' | 'agreed_live'): string {
  const label = OUTBOUND_CONNECTOR_LABEL[connector]
  const grant = OUTBOUND_GRANT_ENV[connector]
  const cutoff = PRODUCER_CUTOFF_ENV[connector]
  switch (detail) {
    case 'agreed_held':
      return `${label}: held. Neither ${grant} nor ${cutoff} is set, so IMS records what it would have written as a shadow and sends nothing.`
    case 'agreed_live':
      return `${label}: ${grant} and ${cutoff} are both readable, so IMS produces work for the operations it owns from the live-from instant.`
    case 'cutoff_without_grant':
      return `${label}: INCONSISTENT. ${cutoff} is set but ${grant} is not, so work is shadowed and the transport would refuse it anyway. Set both or neither.`
    case 'grant_without_cutoff':
      return `${label}: INCONSISTENT. ${grant} is set but ${cutoff} is not, so the transport would allow writes while every producer shadows its work and nothing is queued. Set both or neither.`
    case 'unreadable':
      return `${label}: ${grant} or ${cutoff} is set but cannot be read, so work is shadowed. Fix the value.`
  }
}

// ---------------------------------------------------------------------------------------------
// Documentation blocks
// ---------------------------------------------------------------------------------------------

export const PRODUCER_DOC_BLOCK_OPEN = (id: string) => `<!-- producer-disposition:${id} -->`
export const PRODUCER_DOC_BLOCK_CLOSE = (id: string) => `<!-- /producer-disposition:${id} -->`

export type ProducerDocBlockId = 'overview' | 'cutoffs'

const CUTOFF_ROWS = OUTBOUND_CONNECTORS.map(
  (connector) => `| \`${PRODUCER_CUTOFF_ENV[connector]}\` | ${OUTBOUND_CONNECTOR_LABEL[connector]} | ${PRODUCER_CUTOFF_FORMAT} |`,
)

export const PRODUCER_DOC_BLOCKS: Record<ProducerDocBlockId, string> = {
  overview: [
    'The outbound-write hold refuses a request at the HTTP boundary. The producer-side hold decides earlier whether a piece of work is queued for delivery at all. For each destination and operation the decision is LIVE or SHADOW. A SHADOW is a record of what IMS would have written; it is never queued and never delivered later. The decision reads the environment only: no database and no network call.',
    '',
    'Work is LIVE only when every one of these holds, and SHADOW otherwise: the outbound-write grant for the destination is readable; the live-from variable for the destination is set and readable; the current time is at or after it; the ownership map says IMS owns that operation in the installation phase that follows from the two; and the time of the business event is at or after the live-from instant (an operation whose ownership-map row requires that time is shadowed when the producer does not supply it). A value that is absent, unreadable or inconsistent is never LIVE. There is no phase setting: an installation is in its live phase for a destination exactly when the grant and the live-from instant are both in force, so a restored backup, a clone or a new checkout never inherits it.',
    '',
    'A grant without a live-from instant, or a live-from instant without a grant, is inconsistent. Both directions are safe (nothing is delivered), and both are reported. Never move a live-from instant earlier once work has been produced after it: that is the only change that lets work from before the move reach the destination.',
  ].join('\n'),
  cutoffs: [
    '| Variable | Destination | Value |',
    '|---|---|---|',
    ...CUTOFF_ROWS,
    '',
    'Each variable names one instant. A date without a time, a time without the Z, an offset such as +01:00, precision finer than a millisecond, surrounding whitespace, a list or any other shape is unreadable and keeps the destination in shadow. Setting a variable does not start any writer; each destination also needs its outbound-write grant, and the ownership map decides which operations IMS may produce.',
  ].join('\n'),
}

export const PRODUCER_DOC_PLACEMENTS: ReadonlyArray<{ file: string; blocks: readonly ProducerDocBlockId[] }> = [
  { file: 'docs/installation.md', blocks: ['overview', 'cutoffs'] },
]

export function renderProducerDocBlock(id: ProducerDocBlockId): string {
  return `${PRODUCER_DOC_BLOCK_OPEN(id)}\n${PRODUCER_DOC_BLOCKS[id]}\n${PRODUCER_DOC_BLOCK_CLOSE(id)}`
}
