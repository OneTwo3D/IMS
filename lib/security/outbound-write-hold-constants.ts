/**
 * THE ONE PLACE THE OUTBOUND-WRITE HOLD'S WORDS AND NAMES LIVE.
 *
 * Everything an operator reads about the hold - the environment variable names, the refusal text,
 * the `outbound:status` exit-code table and the paragraphs that docs/installation.md and
 * docs/woocommerce-live-runbook.md carry - is defined here and nowhere else. The code imports these
 * values; the docs carry marked blocks whose body must equal the text below byte for byte, and
 * tests/security/outbound-write-hold-docs.test.ts checks EVERY marked block against this module
 * (a universal check: a stale block beside a correct one fails). Change a word here and the docs
 * test fails until the docs are regenerated, which is the point.
 *
 * This module is dependency-free on purpose: the status script, the transport, the tests and the
 * docs check all import it, and none of them should need a database to read a sentence.
 */

export const OUTBOUND_CONNECTORS = ['woocommerce', 'mintsoft', 'xero'] as const
export type OutboundConnector = (typeof OUTBOUND_CONNECTORS)[number]

export const OUTBOUND_CONNECTOR_LABEL: Record<OutboundConnector, string> = {
  woocommerce: 'WooCommerce',
  mintsoft: 'Mintsoft',
  xero: 'Xero',
}

/** The ONLY inputs to the hold. Environment variables, never settings rows (see OVERVIEW below). */
export const OUTBOUND_GRANT_ENV: Record<OutboundConnector, string> = {
  woocommerce: 'WC_WRITEBACK_ALLOWED_ORIGIN',
  mintsoft: 'MINTSOFT_WRITE_ALLOWED',
  xero: 'XERO_WRITE_ALLOWED_TENANT',
}

/** What each variable must look like, in operator words. */
export const OUTBOUND_GRANT_FORMAT: Record<OutboundConnector, string> = {
  woocommerce: 'exactly one store origin, for example https://shop.example.com',
  mintsoft: 'the Mintsoft base URL and the ClientId separated by one vertical bar, for example https://api.mintsoft.co.uk|89',
  xero: 'exactly one Xero tenant id (a UUID)',
}

export const OUTBOUND_HELD_ACTION = 'OUTBOUND_WRITE_HELD'
export const OUTBOUND_HELD_TAG = 'outbound-write-hold'
export const OUTBOUND_HELD_TEXT_PREFIX = 'Outbound write HELD'
/**
 * A refusal on a REDIRECT HOP. The request that was redirected had already been sent, so this is NOT a
 * held write: it is a possibly-applied one. It deliberately does not start with OUTBOUND_HELD_TEXT_PREFIX,
 * so nothing that recognises a hold (and therefore retries without spending an attempt) recognises it; it
 * takes the ordinary failure path every queue already has for "may have been sent".
 */
export const OUTBOUND_REDIRECT_REFUSED_TEXT_PREFIX = 'Outbound write REFUSED AFTER A REDIRECT'

/** One refusal per connector and code is logged per this window; the rest are counted, not logged. */
export const OUTBOUND_REFUSAL_LOG_WINDOW_MS = 60_000

export type OutboundWriteRefusalCode =
  | 'no_grant'
  | 'unreadable_grant'
  | 'destination_mismatch'
  | 'client_mismatch'
  | 'client_unproven'
  | 'tenant_unproven'
  | 'unparseable_target'

export const OUTBOUND_REFUSAL_CODES: readonly OutboundWriteRefusalCode[] = [
  'no_grant',
  'unreadable_grant',
  'destination_mismatch',
  'client_mismatch',
  'client_unproven',
  'tenant_unproven',
  'unparseable_target',
]

export function outboundRemedyText(connector: OutboundConnector): string {
  return `To let this installation write to the ${OUTBOUND_CONNECTOR_LABEL[connector]} destination it owns, set ${OUTBOUND_GRANT_ENV[connector]} (${OUTBOUND_GRANT_FORMAT[connector]}) in its environment and restart it. Leave it unset on every installation that must not write.`
}

/** How long a work item that was held waits before it is offered again. */
export const OUTBOUND_HELD_RETRY_DELAY_MS = 15 * 60_000

/**
 * Whether a failure text is a hold's text. Work queues that bound their retries use this to NOT spend an
 * attempt on a held write: a hold is a decision of this installation, not a failure of the work, so it
 * must neither count toward a dead-letter nor ever reach one. `includes`, not `startsWith`, because
 * callers wrap the text ("Contact error: ...", "Failed to push ...: ...").
 */
export function isOutboundWriteHeldText(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(`${OUTBOUND_HELD_TEXT_PREFIX} (`)
}

export type OutboundRefusalReasonInput = {
  connector: OutboundConnector
  code: OutboundWriteRefusalCode
  /** What the installation granted (origin, base URL + ClientId, tenant id), or null when nothing readable. */
  granted: string | null
  /** What the request was aimed at (origin, ClientId, tenant id), or null when it could not be established. */
  attempted: string | null
}

/** WHY the request was refused: one sentence, no claim about what was or was not sent. */
export function outboundRefusalReason(input: OutboundRefusalReasonInput): string {
  const label = OUTBOUND_CONNECTOR_LABEL[input.connector]
  const env = OUTBOUND_GRANT_ENV[input.connector]
  const attempted = input.attempted ?? '(not established)'
  switch (input.code) {
    case 'no_grant':
      return `${env} is not set, so this installation has declared no ${label} destination it may write to.`
    case 'unreadable_grant':
      return `${env} is set but cannot be read as ${OUTBOUND_GRANT_FORMAT[input.connector]}, so it grants nothing.`
    case 'destination_mismatch':
      return `this installation may write only to ${input.granted ?? '(nothing readable)'}, but the request was aimed at ${attempted}.`
    case 'client_mismatch':
      return `this installation may write only for ${label} ClientId ${input.granted ?? '(nothing readable)'}, but the request is for ClientId ${attempted}.`
    case 'client_unproven':
      return `the ${label} ClientId this request is for could not be established, so it cannot be shown to be the granted ClientId ${input.granted ?? '(nothing readable)'}.`
    case 'tenant_unproven':
      return `the ${label} tenant this request is for could not be established, so it cannot be shown to be the granted tenant ${input.granted ?? '(nothing readable)'}.`
    case 'unparseable_target':
      return `the request target has no comparable destination, so it cannot be shown to be the granted ${label} destination.`
    default: {
      const unhandled: never = input.code
      throw new Error(`unhandled outbound refusal code ${String(unhandled)}`)
    }
  }
}

export type OutboundHeldMessageInput = OutboundRefusalReasonInput & {
  method: string
  /** Origin plus path of the refused request, query string removed. */
  target: string
  /** 0 for the request as made; 1 and up for a redirect hop. */
  hop: number
}

/**
 * The full text an operator sees.
 *
 * Hop 0 is refused before any socket exists, so "nothing was sent" is a statement about this very
 * request and is made. A redirect hop (hop >= 1) is different: the request that was redirected HAS
 * ALREADY been sent, and the text says so instead of claiming nothing left.
 */
export function outboundHeldMessage(input: OutboundHeldMessageInput): string {
  const label = OUTBOUND_CONNECTOR_LABEL[input.connector]
  const reason = outboundRefusalReason(input)
  const remedy = outboundRemedyText(input.connector)
  if (input.hop === 0) {
    return `${OUTBOUND_HELD_TEXT_PREFIX} (${label}): ${reason} ${input.method} ${input.target} was refused before it left IMS, so nothing was sent to ${label}. This is a hold on this installation, not a rejection by ${label}. ${remedy}`
  }
  return `${OUTBOUND_REDIRECT_REFUSED_TEXT_PREFIX} (${label}): ${reason} Redirect hop ${input.hop} (${input.method} ${input.target}) was refused before it left IMS, but the request that was redirected HAD ALREADY been sent to ${label} and may have taken effect: check ${label} for its effect before repeating it. It is treated as a failure whose outcome is unknown, not as a hold. ${remedy}`
}

// ---------------------------------------------------------------------------------------------
// outbound:status
// ---------------------------------------------------------------------------------------------

export const OUTBOUND_STATUS_COMMAND = 'npm run outbound:status'

export type OutboundStatusExitCode = {
  code: number
  name: string
  meaning: string
}

/**
 * The exit-code table of `outbound:status`, documented ONCE (here) and rendered into the docs from
 * here. When several conditions hold the numerically listed PRECEDENCE below decides; it is the order
 * of this array.
 */
export const OUTBOUND_STATUS_EXIT_CODES: readonly OutboundStatusExitCode[] = [
  { code: 5, name: 'failed', meaning: 'the report could not be produced because of an unexpected error' },
  { code: 3, name: 'usage', meaning: 'an unknown argument was given; nothing was evaluated' },
  { code: 4, name: 'expected-held-violated', meaning: '`--expect-held` was given and at least one connector has a readable grant (IMS may write to something)' },
  { code: 1, name: 'unreadable-grant', meaning: 'a grant variable is set but unreadable; it is treated as no grant (held) but it is an operator error to fix' },
  { code: 2, name: 'counts-unavailable', meaning: 'the grant states were printed but the recent refusal counts could not be read from the database' },
  { code: 0, name: 'ok', meaning: 'the report was produced, every grant variable is absent or readable, and the refusal counts were read; a fully held installation is a success' },
]

export function renderOutboundStatusExitCodeTable(): string {
  const rows = [...OUTBOUND_STATUS_EXIT_CODES]
    .sort((left, right) => left.code - right.code)
    .map((row) => `| ${row.code} | ${row.name} | ${row.meaning} |`)
  return ['| Exit code | Name | Meaning |', '|---|---|---|', ...rows].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Documentation blocks
// ---------------------------------------------------------------------------------------------

export const OUTBOUND_DOC_BLOCK_OPEN = (id: string) => `<!-- outbound-write-hold:${id} -->`
export const OUTBOUND_DOC_BLOCK_CLOSE = (id: string) => `<!-- /outbound-write-hold:${id} -->`

export type OutboundDocBlockId = 'overview' | 'grants' | 'held-meaning' | 'status-command' | 'wc-grant'

const GRANT_ROWS = OUTBOUND_CONNECTORS.map(
  (connector) => `| \`${OUTBOUND_GRANT_ENV[connector]}\` | ${OUTBOUND_CONNECTOR_LABEL[connector]} | ${OUTBOUND_GRANT_FORMAT[connector]} |`,
)

/**
 * The paragraphs the docs carry. Each is the exact body of a marked block; see the docs test.
 * Written for an operator: what the hold is, what unlocks it, what a held write looks like.
 */
export const OUTBOUND_DOC_BLOCKS: Record<OutboundDocBlockId, string> = {
  overview: [
    'IMS refuses every request that could change something in WooCommerce, Mintsoft or Xero unless the environment of this installation names the one destination it may write to. The refusal is made at the HTTP boundary that every connector request goes through, on every request and on every redirect hop, and the default is to refuse. The permission is read from environment variables only and never from the database, so a restored backup, a cloned installation or a new checkout does not inherit a permission that was granted to a different installation. A value that cannot be read is not a permission. Reading is never held: only requests that could change something are.',
  ].join('\n'),
  grants: [
    '| Variable | Connector | Value |',
    '|---|---|---|',
    ...GRANT_ROWS,
    '',
    'Each variable names exactly one destination. A list, a wildcard, a boolean or a value in any other shape is unreadable and grants nothing. Changing the store URL, the Mintsoft base URL or the Xero organisation in Settings revokes the permission instead of inheriting it, because the comparison is against the destination of the request that is actually being made. Setting a variable changes what the installation may do; it does not start any writer.',
  ].join('\n'),
  'held-meaning': [
    'A held write is a hold on this installation and not a rejection by the destination. The request is refused before it leaves IMS, so nothing is sent to the destination, and the work that wanted to write is reported as failed with text that begins "Outbound write HELD". A held write is never recorded as sent, accepted or rejected by the destination. Queues that bound their retries (the WooCommerce and Xero outboxes, the Xero sync log, the Mintsoft order push and the WMS dispatch reconcile) do not spend an attempt on a held write and never dead-letter it, however long the hold lasts: the work stays queued and is offered again every 15 minutes. Pushes that have no queue (the WooCommerce product metadata and WMS status pushes, tracking pushes made outside order completion, and exchange-rate pushes) are not retried by the hold; they are reported in the log and run again at their next trigger. The exception to "nothing was sent" is a redirect: when the destination redirects a request that was granted and the next hop is refused, the first request had already been sent and may have taken effect. That refusal begins "Outbound write REFUSED AFTER A REDIRECT", is not a hold, and is treated like any other failure of unknown outcome: it spends an attempt and can be dead-lettered for an operator to check.',
    '',
    'Mintsoft\'s key-minting login (`POST /api/Auth`) is a write and is held. An installation that authenticates to Mintsoft with a username and password cannot renew its token while held, so its reads stop once the stored token expires; use the fixed API key mode on any installation that is held. Xero\'s token exchange (`POST https://identity.xero.com/connect/token`, https only, exactly that path, on every redirect hop) is allowed as a deliberate exception: it rotates IMS\'s own Xero credentials but changes no accounting data, and every Xero read depends on it. Every Xero write must reach `api.xero.com` on every hop; a redirect to any other origin is refused before the body is sent.',
  ].join('\n'),
  'status-command': [
    `\`${OUTBOUND_STATUS_COMMAND}\` answers "is this installation writing to anything?". It reads only the environment and the activity log, makes no network call and writes nothing. It prints, for each connector, whether writes are held or granted (and to which destination), whether the grant variable is unreadable, and how many refused writes were logged in the last 24 hours (a lower bound: refusals the rate limit suppressed are added only when the next entry is written). Pass \`--json\` for a machine-readable report and \`--expect-held\` to fail when any connector may write.`,
    '',
    renderOutboundStatusExitCodeTable(),
  ].join('\n'),
  'wc-grant': [
    `Before IMS may write to a WooCommerce store, set ${OUTBOUND_GRANT_ENV.woocommerce} to the origin of that one store (${OUTBOUND_GRANT_FORMAT.woocommerce}) in the environment of the installation that owns writeback for it, and restart that installation. An installation that must not write to the live store - every development, stage, end-to-end and rehearsal installation, and the production installation during the period in which IMS only reads - leaves it unset. The origin is compared with the store URL of each request, including after a redirect, so pointing an installation at a different store does not carry the permission across.`,
  ].join('\n'),
}

/** Which docs carry which block. The docs test requires each pair exactly once and no other block. */
export const OUTBOUND_DOC_PLACEMENTS: ReadonlyArray<{ file: string; blocks: readonly OutboundDocBlockId[] }> = [
  { file: 'docs/installation.md', blocks: ['overview', 'grants', 'held-meaning', 'status-command'] },
  { file: 'docs/woocommerce-live-runbook.md', blocks: ['overview', 'wc-grant', 'held-meaning'] },
]

export function renderOutboundDocBlock(id: OutboundDocBlockId): string {
  return `${OUTBOUND_DOC_BLOCK_OPEN(id)}\n${OUTBOUND_DOC_BLOCKS[id]}\n${OUTBOUND_DOC_BLOCK_CLOSE(id)}`
}
