/**
 * THE ONE PLACE THE PRODUCER-SIDE HOLD'S WORDS AND NAMES LIVE.
 *
 * The outbound-write hold (outbound-write-hold-constants.ts) refuses a request at the HTTP boundary.
 * The producer-side hold is a decision, consulted by producers, between a unit of IMS work being LIVE
 * (produced for delivery) and being a SHADOW (what IMS would have written, never delivered). A destination is
 * consulted only when PRODUCER_HOLD_ENFORCED_ENV names it (see lib/security/producer-seam.ts); today the Xero
 * producers are wired and the others are not. This
 * module carries the environment variable names, the formats, the reason texts and the documentation
 * blocks of that decision. lib/security/producer-disposition.ts imports them; docs/installation.md
 * carries marked blocks whose body must equal the text below byte for byte, and
 * tests/security/producer-disposition-docs.test.ts checks EVERY marked block against this module.
 *
 * No dependency beyond the grant names: the decision, the tests and the docs check all import this and
 * none of them should need a database to read a sentence.
 */

import type { WriterOwner } from './writer-ownership-map'
import {
  OUTBOUND_CONNECTORS,
  OUTBOUND_CONNECTOR_LABEL,
  OUTBOUND_GRANT_ENV,
  type OutboundConnector,
} from './outbound-write-hold-constants'

/**
 * Which destinations' producers obey the decision. Environment only, like the grants and the live-from
 * instants. UNSET (the default) means no producer obeys it and every producer behaves exactly as it did before the
 * decision existed; the outbound-write hold at the transport is then the only barrier.
 */
export const PRODUCER_HOLD_ENFORCED_ENV = 'PRODUCER_HOLD_ENFORCED_DESTINATIONS'

export const PRODUCER_HOLD_ENFORCED_FORMAT = 'a comma-separated list of destinations from xero, mintsoft and woocommerce, or all; unset or empty enforces nothing'

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
  'invalid_input',
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
  invalid_input: 'the destination or operation is not a plain string',
  unreadable: 'the decision could not be evaluated',
}

/** How an operator reads an owner in a sentence. */
export const WRITER_OWNER_LABEL: Record<WriterOwner, string> = {
  IMS: 'IMS',
  xeroom: 'Xeroom',
  'o3d-ioss-xero': 'the IOSS filter for Xeroom',
  'woo-mintsoft-plugin': 'the WooCommerce-Mintsoft plugin',
  'mintsoft-native': 'Mintsoft itself',
  'operator-manual': 'an operator working by hand',
  'qoblex-native': 'Qoblex',
  aelia: 'the Aelia currency plugin',
  'woocommerce-native': 'WooCommerce itself',
  nobody: 'no writer (the operation is not performed by any system)',
  unknown: 'nobody has been established as the owner',
}

/**
 * THE ONE SENTENCE AN OPERATOR SEES WHEN IMS KEPT A SHADOW INSTEAD OF PRODUCING THE WORK. Shown on the accounting sync
 * log row, in a refused action's result and in the activity log; nothing else words it.
 *
 * It claims only what IMS knows: IMS did not send it. It says nothing about whether the owner did, and it tells the
 * operator to look at the destination rather than to act, because a shadow is not evidence about the destination.
 */
export function producerShadowNotice(input: { connector: OutboundConnector; reason: ProducerReason; owner: WriterOwner }): string {
  const label = OUTBOUND_CONNECTOR_LABEL[input.connector]
  const owner = WRITER_OWNER_LABEL[input.owner]
  return `Not sent by IMS: writes to ${label} are held on this installation (${PRODUCER_REASON_TEXT[input.reason]}). `
    + `Owner of this operation in the current phase: ${owner}. IMS kept a shadow record of what it would have written and queued nothing. `
    + `This does not say whether ${input.owner === 'unknown' || input.owner === 'nobody' ? 'anything' : owner} has written it to ${label}: check ${label} before acting.`
}

/**
 * THE SENTENCE FOR A ROW THAT ALREADY EXISTS AND IS NOT SENT: the claim boundary found a queued row whose decision is not
 * LIVE and handed it back unsent. Unlike {@link producerShadowNotice} it records no shadow (the row is the queued work itself),
 * so it does not say one was kept. It claims only what IMS knows: IMS did not send it, and will not while the hold says so.
 */
export function producerHeldNotice(input: { connector: OutboundConnector; reason: ProducerReason; owner: WriterOwner }): string {
  const label = OUTBOUND_CONNECTOR_LABEL[input.connector]
  const owner = WRITER_OWNER_LABEL[input.owner]
  return `Not sent by IMS: writes to ${label} are held on this installation (${PRODUCER_REASON_TEXT[input.reason]}). `
    + `Owner of this operation in the current phase: ${owner}. This queued entry was handed back unsent and is not sent while the hold stands. `
    + `This does not say whether ${input.owner === 'unknown' || input.owner === 'nobody' ? 'anything' : owner} has written it to ${label}: check ${label} before acting.`
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
      return `${label}: held. Neither ${grant} nor ${cutoff} is set, so the producer-side decision for every ${label} operation is SHADOW.`
    case 'agreed_live':
      return `${label}: ${grant} and ${cutoff} are both readable, so the producer-side decision is LIVE for the operations IMS owns from the live-from instant and SHADOW for the rest.`
    case 'cutoff_without_grant':
      return `${label}: INCONSISTENT. ${cutoff} is set but ${grant} is not, so the producer-side decision is SHADOW and the transport refuses ${label} writes. Set both or neither.`
    case 'grant_without_cutoff':
      return `${label}: INCONSISTENT. ${grant} is set but ${cutoff} is not, so the producer-side decision is SHADOW while the transport allows ${label} writes. Set both or neither.`
    case 'unreadable':
      return `${label}: ${grant} or ${cutoff} is set but cannot be read, so the producer-side decision is SHADOW. Fix the value.`
  }
}

// ---------------------------------------------------------------------------------------------
// Documentation blocks
// ---------------------------------------------------------------------------------------------

export const PRODUCER_DOC_BLOCK_OPEN = (id: string) => `<!-- producer-disposition:${id} -->`
export const PRODUCER_DOC_BLOCK_CLOSE = (id: string) => `<!-- /producer-disposition:${id} -->`

export type ProducerDocBlockId = 'overview' | 'cutoffs' | 'enforcement'

const CUTOFF_ROWS = OUTBOUND_CONNECTORS.map(
  (connector) => `| \`${PRODUCER_CUTOFF_ENV[connector]}\` | ${OUTBOUND_CONNECTOR_LABEL[connector]} | ${PRODUCER_CUTOFF_FORMAT} |`,
)

export const PRODUCER_DOC_BLOCKS: Record<ProducerDocBlockId, string> = {
  overview: [
    `THE PRODUCER-SIDE HOLD IS ENFORCED ONLY FOR THE DESTINATIONS NAMED IN \`${PRODUCER_HOLD_ENFORCED_ENV}\`, WHICH IS UNSET BY DEFAULT. Unset, every producer queues work exactly as it did before the decision existed, and the only barrier is the outbound-write hold above, which reads a grant on its own: a destination whose grant is set permits the outbound writes through the transport whether or not the live-from variable below is set. Today only the Xero producers consult the decision (every place IMS creates an accounting sync log row, and the direct tax-rate creation from Settings; the one sync log type whose destination is WooCommerce, the invoice note, follows the WooCommerce setting); the WooCommerce and Mintsoft producers do not yet, so naming them in the variable changes nothing for them in this version, and \`npm run outbound:status\` does not report on the decision.`,
    '',
    'For each destination and operation the decision is LIVE or SHADOW. It is LIVE only when every one of these holds, and SHADOW otherwise: the outbound-write grant for the destination is readable; the live-from variable for the destination is set and readable; the current time is at or after it; the ownership map says IMS owns that operation in the installation phase that follows from the two; and the time of the business event is at or after the live-from instant (an operation whose ownership-map row requires that time is SHADOW when the producer does not supply it). A value that is absent, unreadable or inconsistent is never LIVE. There is no phase setting: an installation is in its live phase for a destination exactly when the grant and the live-from instant are both in force, so a restored backup, a clone or a new checkout never inherits it. The decision itself reads the environment only: no database and no network call.',
    '',
    'A SHADOW is the record of what IMS would have written, kept instead of queuing the work; it is never delivered later. For Xero a shadow is a row in the accounting sync log that is CANCELLED with the settlement basis `HELD_SHADOW`, plus a row in `outbound_shadow_writes` (one per distinct piece of work, counting repeats). A shadow has no outbox job, is never given an accounting event, and has its own ledger standing (shadow, not sent by IMS) that is NOT proof the document is absent from Xero: it says nothing about whether the owner of the operation wrote it, so deleting, reversing or refunding over it is refused as unproven. A destination whose enforcement is on and whose grant and live-from instant are both unset therefore queues nothing new: every Xero write IMS would have produced becomes a shadow.',
    '',
    'A grant without a live-from instant, or a live-from instant without a grant, is inconsistent: the decision is SHADOW, while the transport still allows the writes of a granted destination. A later change will report the inconsistency in `npm run outbound:status`. Never move a live-from instant earlier once work has been produced after it: that is the only change that lets work from before the move reach the destination. Rows already queued when enforcement is switched on are not changed, but the Xero queue processor asks the same decision immediately before it sends: a row whose decision is not LIVE is handed back unsent with the operator text (no retry is spent) and is never posted, and a manual retry or the daily-batch reset does not make such a row claimable again. A later change will also refuse to deliver a row created before the live-from instant and retire the backlog.',
  ].join('\n'),
  cutoffs: [
    '| Variable | Destination | Value |',
    '|---|---|---|',
    ...CUTOFF_ROWS,
    '',
    `Each variable names one instant. A date without a time, a time without the Z, an offset such as +01:00, precision finer than a millisecond, surrounding whitespace, a list or any other shape is unreadable, and the decision for that destination is SHADOW. A destination needs its outbound-write grant as well as its live-from instant before the decision can be LIVE, and the ownership map decides which operations IMS may produce. A variable has an effect only for a destination named in \`${PRODUCER_HOLD_ENFORCED_ENV}\`.`,
  ].join('\n'),
  enforcement: [
    '| Variable | Value |',
    '|---|---|',
    `| \`${PRODUCER_HOLD_ENFORCED_ENV}\` | ${PRODUCER_HOLD_ENFORCED_FORMAT} |`,
    '',
    `Names the destinations whose producers obey the decision. A destination that is named obeys it for every operation; one that is not named is untouched. A value that is not a list of known destinations or \`all\` (a misspelling, a destination that does not exist) enforces EVERY destination, because a typo must not leave a hold off. Switching it on for Xero on an installation with no grant and no live-from instant makes every new Xero write a shadow and stops the Xero queue from receiving new work; switching it off again does not recover shadows, which are records and not queued work. Do not switch it on for WooCommerce or Mintsoft in this version: those producers do not consult the decision yet.`,
  ].join('\n'),
}

export const PRODUCER_DOC_PLACEMENTS: ReadonlyArray<{ file: string; blocks: readonly ProducerDocBlockId[] }> = [
  { file: 'docs/installation.md', blocks: ['overview', 'cutoffs', 'enforcement'] },
]

export function renderProducerDocBlock(id: ProducerDocBlockId): string {
  return `${PRODUCER_DOC_BLOCK_OPEN(id)}\n${PRODUCER_DOC_BLOCKS[id]}\n${PRODUCER_DOC_BLOCK_CLOSE(id)}`
}
