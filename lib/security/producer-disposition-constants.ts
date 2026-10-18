/**
 * THE ONE PLACE THE PRODUCER-SIDE HOLD'S WORDS AND NAMES LIVE.
 *
 * The outbound-write hold (outbound-write-hold-constants.ts) refuses a request at the HTTP boundary.
 * The producer-side hold is a decision, consulted by producers, between a unit of IMS work being LIVE
 * (produced for delivery) and being a SHADOW (what IMS would have written, never delivered). A destination is
 * consulted only when PRODUCER_HOLD_ENFORCED_ENV names it (see lib/security/producer-seam.ts); today the Xero,
 * WooCommerce and Mintsoft producers are all wired. This
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

/**
 * THE SENTENCE FOR WORK THAT WAS QUEUED BEFORE THE DESTINATION'S LIVE-FROM INSTANT AND IS REFUSED DELIVERY (the writer-side cut-off).
 *
 * Shown wherever a queued row, job or link is handed back or refused a re-queue because it was created before the instant: the sync
 * log's error message, the exception inbox, a refused retry or replay, the outbox listing. It claims only what IMS knows: IMS will not
 * send it. Whether the writer that owned the destination then wrote it is not known here, so it points at the destination and
 * instructs nothing.
 */
export function producerBeforeCutoffNotice(input: { connector: OutboundConnector; cutoff: Date }): string {
  const label = OUTBOUND_CONNECTOR_LABEL[input.connector]
  const at = Number.isFinite(input.cutoff.getTime()) ? input.cutoff.toISOString() : 'an unreadable instant'
  return `Not sent by IMS: this was queued before writes to ${label} went live on this installation (${at}), so it belongs to the writer that owned ${label} then. `
    + `IMS does not deliver it, however it is re-queued. This does not say whether that writer has written it to ${label}: check ${label} before acting.`
}

/**
 * THE SENTENCE FOR QUEUED WORK THE RETIREMENT COULD NOT PROVE WAS NEVER SENT. Unlike a shadow it makes no statement about what was
 * or was not sent: the record shows an attempt may have left, so the outcome is genuinely unknown and an operator has to look.
 */
export const PRODUCER_UNKNOWN_OUTCOME_PREFIX = 'outcome unknown: check'

export function producerUnknownOutcomeNotice(input: { connector: OutboundConnector; why: string }): string {
  const label = OUTBOUND_CONNECTOR_LABEL[input.connector]
  return `Parked by IMS, ${PRODUCER_UNKNOWN_OUTCOME_PREFIX} ${label} before acting. ${input.why} IMS will not send it and will not re-queue it.`
}

/**
 * THE SENTENCE FOR QUEUED WORK THE RETIREMENT PROVED WAS NEVER SENT BY IMS: its own record carries the positive proof (named in
 * `proof`), and it is kept as a shadow. It still says nothing about the destination: another writer may have produced the same thing.
 */
export function producerRetiredShadowNotice(input: { connector: OutboundConnector; proof: string }): string {
  const label = OUTBOUND_CONNECTOR_LABEL[input.connector]
  return `Retired by IMS and kept as a shadow: this was queued before writes to ${label} were live, and the record shows IMS made no attempt to send it (${input.proof}). `
    + `IMS does not deliver it. This does not say whether another writer has written it to ${label}: check ${label} before acting.`
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
// `npm run retire:held-backlog`: its exit codes are ONE table, rendered into docs/installation.md and checked there.
// ---------------------------------------------------------------------------------------------

export type RetireExitCode = { code: number; name: string; meaning: string }

export const RETIRE_HELD_BACKLOG_COMMAND = 'npm run retire:held-backlog'

export const RETIRE_HELD_BACKLOG_EXIT_CODES: readonly RetireExitCode[] = [
  { code: 3, name: 'usage', meaning: 'an unknown or malformed argument, or `--apply` without `--confirm-database`; nothing was read or changed' },
  { code: 4, name: 'apply-refused', meaning: '`--confirm-database` does not equal the server identity of the connection (or the identity cannot be read); nothing was changed' },
  { code: 5, name: 'failed', meaning: 'an unexpected error; some rows may have been retired (each row is its own transaction) and the next dry run says which' },
  { code: 2, name: 'nothing-in-scope', meaning: 'no destination had a cut-off (`--cutoff`, or a readable live-from variable) and `--all-queued` was not given, so nothing was selected' },
  { code: 1, name: 'incomplete', meaning: 'the run finished but left work: a list was truncated by `--limit`, a row changed while it was being retired, or a row was skipped because a worker held it; run it again' },
  { code: 0, name: 'ok', meaning: 'the plan was produced (dry run), or every selected row was retired or parked; a dry run changes nothing' },
]

export function renderRetireExitCodeTable(): string {
  const rows = [...RETIRE_HELD_BACKLOG_EXIT_CODES]
    .sort((left, right) => left.code - right.code)
    .map((row) => `| ${row.code} | ${row.name} | ${row.meaning} |`)
  return ['| Exit code | Name | Meaning |', '|---|---|---|', ...rows].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Documentation blocks
// ---------------------------------------------------------------------------------------------

export const PRODUCER_DOC_BLOCK_OPEN = (id: string) => `<!-- producer-disposition:${id} -->`
export const PRODUCER_DOC_BLOCK_CLOSE = (id: string) => `<!-- /producer-disposition:${id} -->`

export type ProducerDocBlockId = 'overview' | 'cutoffs' | 'enforcement' | 'retirement'

const CUTOFF_ROWS = OUTBOUND_CONNECTORS.map(
  (connector) => `| \`${PRODUCER_CUTOFF_ENV[connector]}\` | ${OUTBOUND_CONNECTOR_LABEL[connector]} | ${PRODUCER_CUTOFF_FORMAT} |`,
)

export const PRODUCER_DOC_BLOCKS: Record<ProducerDocBlockId, string> = {
  overview: [
    `THE PRODUCER-SIDE HOLD IS ENFORCED ONLY FOR THE DESTINATIONS NAMED IN \`${PRODUCER_HOLD_ENFORCED_ENV}\`, WHICH IS UNSET BY DEFAULT. Unset, every producer queues work exactly as it did before the decision existed, and the only barrier is the outbound-write hold above, which reads a grant on its own: a destination whose grant is set permits the outbound writes through the transport whether or not the live-from variable below is set. Today the Xero producers, the WooCommerce producers and the Mintsoft producers consult the decision, and \`npm run outbound:status\` reports on it for every destination it is enforced for. The Xero producers are every place IMS creates an accounting sync log row and the direct tax-rate creation from Settings; the one sync log type whose destination is WooCommerce, the invoice note, follows the WooCommerce setting. The WooCommerce producers are every stock push (the queue, the daily reconcile, the manual push and a webhook correction), the order completion, cancel and hold jobs, tracking, partial shipments, the WMS-status meta, product metadata, FX rates and the FX helper probe, and the registration of webhooks. The Mintsoft producers are every place IMS creates, amends, holds or cancels a warehouse order (the order-push sweep, and the two operator buttons that re-arm a create), posts a note on a warehouse order (the sweep's notes and the refund note), upserts a product or sends its descriptions and picture, creates a bundle, or creates an ASN.`,
    '',
    'For each destination and operation the decision is LIVE or SHADOW. It is LIVE only when every one of these holds, and SHADOW otherwise: the outbound-write grant for the destination is readable; the live-from variable for the destination is set and readable; the current time is at or after it; the ownership map says IMS owns that operation in the installation phase that follows from the two; and the time of the business event is at or after the live-from instant (an operation whose ownership-map row requires that time is SHADOW when the producer does not supply it). A value that is absent, unreadable or inconsistent is never LIVE. There is no phase setting: an installation is in its live phase for a destination exactly when the grant and the live-from instant are both in force, so a restored backup, a clone or a new checkout never inherits it. The decision itself reads the environment only: no database and no network call.',
    '',
    'A SHADOW is the record of what IMS would have written, kept instead of queuing the work; it is never delivered later. For Xero a shadow is a row in the accounting sync log that is CANCELLED with the settlement basis `HELD_SHADOW`, plus a row in `outbound_shadow_writes` (one per distinct piece of work, counting repeats). A shadow has no outbox job, is never given an accounting event, and has its own ledger standing (shadow, not sent by IMS) that is NOT proof the document is absent from Xero: it says nothing about whether the owner of the operation wrote it, so deleting, reversing or refunding over it is refused as unproven. A destination whose enforcement is on and whose grant and live-from instant are both unset therefore queues nothing new: every Xero write IMS would have produced becomes a shadow. For WooCommerce a shadow is the `outbound_shadow_writes` row alone (there is no sync log row): nothing is queued, no outbox job exists, nothing is sent, and the result the caller gets is its own `shadowed` outcome, which is not queued, not sent and not a failure to retry. A push the hold shadowed is never stamped as pushed (the stock echo-suppression record, the WMS-status record and the daily stock reconcile stamp are left alone), and an order that ships, cancels or goes on hold commits exactly as it would without the storefront job. The queue drains for WooCommerce stock, order completion and order cancel and hold stand down while the hold stands: they claim nothing and spend no attempt, so a job queued before enforcement was switched on stays as it is and is never sent. The transport helpers (the REST POST and PUT, the FX push and probe, the partial-shipment push) refuse as a last barrier. For Mintsoft a shadow is likewise the `outbound_shadow_writes` row alone: no order link is created, claimed, stamped or moved (the order is simply offered again on the next sweep), no ASN reservation or sync job is made, no product or bundle is marked as synced or claimed, and the result the caller gets is its own `shadowed` outcome, which is not created, not queued and not a failure to retry. The sweep passes that only re-open a create (releasing a held order, revalidating a failed one, re-queuing an unknown create) stand down while the warehouse is held, and a link that is waiting for its ownership to be proved, or is parked as an unknown create, is never turned into a shadow. Every Mintsoft write method needs a clearance that only the producer decision can give, and the Mintsoft transport refuses any write as a last barrier in the wording of the outbound-write hold, so a queue that recognises a hold spends no attempt on it and a held write cannot even renew a key.',
    '',
    "A grant without a live-from instant, or a live-from instant without a grant, is inconsistent: the decision is SHADOW, while the transport still allows the writes of a granted destination, and `npm run outbound:status` reports it (exit code `inconsistent`). Never move a live-from instant earlier once work has been produced after it: that is the only change that lets work from before the move reach the destination.",
    '',
    "THE WRITER-SIDE CUT-OFF. Work that already exists when a destination goes live belongs to the writer that owned the destination until then, so once enforcement is on for a destination and it is in its live phase (the grant and the live-from instant both in force, the instant reached) IMS never delivers a queued row created before the live-from instant, whatever its status and however it is re-queued. For Xero, the claim of an accounting sync row carries the instant in its own statement (a row created earlier is not claimed), the queue processor does not even select such rows, no delivery job is created for them, a job that reaches the processor for one is dead-lettered with the operator text, the processor asks again immediately before it sends, and the manual re-queue of a failed row, the daily-batch reset and the revival of a failed follow-up each decline to make such a row claimable again (a declined follow-up revival creates a new row, which the decision judges on its own business-event time). For the outbox, the claim of a job of a destination (WooCommerce and Xero; Mintsoft has none today) excludes a job created before the instant, in the selection and in the claim statement, so a bounded oldest-first batch of them can never starve the jobs behind it; a job whose effect is local is never excluded; an operator replay of such a job is refused; and the one job a product keeps for ever (its stock push) is re-dated when a live producer re-arms it, because that is a new push of the current stock and not the old job. For Mintsoft, the create, amend, recovery and not-pushed detection already stop at the order's paid time. It is asked again immediately before every write a claimed job makes, not only when the job is claimed: each WooCommerce drain parks a job older than the instant without sending (in one statement keyed on its own claim), asks again before its tracking, status and stock writes, and the Xero claim proof taken before every remote write carries the floor of that moment. The instant is read from the environment at each of these decisions and cached nowhere, and with the switch off none of it applies.",
    '',
    "Queued work that predates the instant is not left in the queues looking like work that is owed: `npm run retire:held-backlog` takes it out. It is a dry run unless given `--apply --confirm-database <identity>` (the server identity the dry run prints) and is for a scratch or development database, never a live installation. It retires a row as a SHADOW (an accounting sync row becomes CANCELLED with the settlement basis `HELD_SHADOW`; an outbox job becomes `SHADOWED`; a queued Mintsoft order link is removed, with a shadow record) only when the row itself proves that no attempt to send it was ever made: a sync row that was never claimed or retried and was queued in attempt-stamping custody (or a money row in custody with no remote attempt), with no document id and no create-dispatch marker; an outbox job that was never claimed or changed, or whose only recorded outcome is a refusal by the outbound-write hold; a Mintsoft link with no attempt, attempt time or error. For outbox jobs and Mintsoft links that proof also needs a durable history that a replay, a re-arm or a release cannot erase (the job's first-attempt stamp, the link's first-claim stamp, each written when the unit is first claimed, before any request can leave): a unit created before that history existed, or whose stamp is set, is parked, because its visible attempt counters may have been reset. A claim refused by the outbound-write hold withdraws its own stamp only when a count of the writes the transport dispatched in that claim (a completion sends tracking before its status) proves it sent nothing; a claim that sent anything, or ran outside the count, keeps the stamp and is parked. The database enforces that history for every writer, including an older binary during a rollback or a mixed-version deploy: a claim that does not stamp itself makes the row unknown (parked), and the tracked flag can never be switched back on by an update. The mirrored accounting event of a retired sync row is left untouched whenever another attempt at the same document is live or has an unverified outcome, whatever its status, and the retirement says so. Every other row is PARKED, not shadowed, with the text `outcome unknown: check <destination> before acting` (a sync row becomes FAILED, an outbox job PERMANENT_FAILED, a Mintsoft link AMBIGUOUS_CREATE), because the record cannot say it was never sent and IMS does not claim it. A row a worker holds right now is skipped and left for the next run. The command, its arguments and its exit codes are described in the section on retiring the held backlog.",
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
    `Names the destinations whose producers obey the decision. A destination that is named obeys it for every operation; one that is not named is untouched. A value that is not a list of known destinations or \`all\` (a misspelling, a destination that does not exist) enforces EVERY destination, because a typo must not leave a hold off. Switching it on for Xero on an installation with no grant and no live-from instant makes every new Xero write a shadow and stops the Xero queue from receiving new work; switching it off again does not recover shadows, which are records and not queued work. Switching it on for Mintsoft on an installation with no grant and no live-from instant makes every Mintsoft write IMS would have produced a shadow (orders, amendments, holds, cancellations, notes, products, bundles, ASNs and product content), stops the order-push sweep from creating or re-opening anything, and refuses the buttons that re-arm a create; reads, the despatch poll and the stock alignment are not affected; key minting (POST /api/Auth, which replaces the tenant API key every other integration uses) is refused with a hold text, before anything is sent, until the installation is in its live phase (an installation on a fixed API key is unaffected). Switching it on for WooCommerce on an installation with no grant and no live-from instant makes every WooCommerce write IMS would have produced a shadow, queues nothing new for the store, and stops the WooCommerce queue drains; the forced stock push stays behind the stock-sync setting as before.`,
  ].join('\n'),
  retirement: [
  `\`${RETIRE_HELD_BACKLOG_COMMAND} [-- --destination xero|mintsoft|woocommerce|all] [-- --cutoff <UTC instant with Z>] [-- --all-queued] [-- --limit N] [-- --json]\` reads the queues and prints what each queued row would become. It prints the identity of the server it is connected to (\`<database>@<cluster system identifier>\`; a database name alone does not identify a server, since a live and a scratch cluster can share one). It changes nothing unless it is also given \`--apply --confirm-database <identity>\` with exactly that token; the identity is checked again on the connection of every row's transaction, and an identity that cannot be read refuses the apply. The apply is for a scratch or development database, run deliberately, and is never run against a live installation. Which rows: those queued before a destination's live-from instant (\`--cutoff\` for every selected destination, otherwise the destination's own live-from variable when it is readable), or every queued row with \`--all-queued\`, which IGNORES any cut-off in the plan and the apply and says so in its report; a destination with neither selects nothing. Each row is retired in its own transaction after being read again and classified again, and is changed only if it is still exactly what was classified, so a row a worker claimed or settled in between, or that a live producer re-dated or re-armed (a product's stock job), is left alone and reported as changed since planning. Each row is locked, its destination, operation and creation time (or the order's paid time) are checked against the effective cut-off again, and the final write repeats them. A row is SHADOWED only when its own record proves no attempt to send it was made; every other row is PARKED with \`${PRODUCER_UNKNOWN_OUTCOME_PREFIX} <destination> before acting\`; a row a worker holds right now is skipped. The accounting event that mirrors a retired sync row is voided (not revivable) only when no other attempt at the same document is live, and marked failed when the row is parked.`,
  '',
  renderRetireExitCodeTable(),
].join('\n'),
}

export const PRODUCER_DOC_PLACEMENTS: ReadonlyArray<{ file: string; blocks: readonly ProducerDocBlockId[] }> = [
  { file: 'docs/installation.md', blocks: ['overview', 'cutoffs', 'enforcement', 'retirement'] },
]

export function renderProducerDocBlock(id: ProducerDocBlockId): string {
  return `${PRODUCER_DOC_BLOCK_OPEN(id)}\n${PRODUCER_DOC_BLOCKS[id]}\n${PRODUCER_DOC_BLOCK_CLOSE(id)}`
}
