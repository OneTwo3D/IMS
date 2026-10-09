/**
 * THE ONE PLACE THE READ-SYNC LIVENESS WORDS, NAMES AND THRESHOLDS LIVE.
 *
 * IMS is kept current by feeds that only READ from a vendor: the WooCommerce order sweep, the Mintsoft
 * stock sync, the Mintsoft despatch poll, the Mintsoft order-status refresh, the Xero balance-snapshot
 * pull and the Xero tax-rate read. A feed that stops looks exactly like a feed that is working and has
 * nothing new to say, so each one carries a LAST-SUCCESS timestamp that is written only by a run that
 * finished its read cleanly - separate from any last-attempt column, which advances on failures too.
 *
 * Everything an operator reads about that - the stream list, the age limit of each stream, the alert
 * wording, the `read-sync:status` exit-code table and the paragraphs docs/installation.md carries - is
 * defined here and nowhere else. The docs carry marked blocks whose body must equal the text below byte
 * for byte, and tests/ops/read-sync-liveness-docs.test.ts checks EVERY marked block against this module.
 *
 * No imports, on purpose: the status script, the alarm, the watchdog, the writers and the tests all read
 * this module and none of them should need a database or a framework to read a number or a sentence.
 */

export const READ_SYNC_STREAM_IDS = [
  'woocommerce-order-sweep',
  'mintsoft-stock-sync',
  'mintsoft-dispatch-poll',
  'mintsoft-order-status',
  'xero-balance-snapshots',
  'xero-tax-rates',
] as const
export type ReadSyncStreamId = (typeof READ_SYNC_STREAM_IDS)[number]

/** Where a stream's last-success timestamp is stored. */
export type ReadSyncSource =
  | { kind: 'setting'; key: string }
  | { kind: 'binding-column'; column: 'lastStockSyncSuccessAt' }
  | { kind: 'sync-job'; connector: 'mintsoft'; jobType: 'DISPATCH_SYNC' }

/** How a stream's age limit is derived. */
export type ReadSyncMaxAge =
  | { kind: 'fixed'; ms: number }
  /** Each binding carries its own cadence; the limit is a multiple of it with a floor. */
  | { kind: 'binding-cadence' }

export type ReadSyncStreamDef = {
  id: ReadSyncStreamId
  label: string
  /** Which connector's switch decides whether the stream is expected to run at all. */
  plugin: 'woocommerce' | 'mintsoft' | 'xero'
  /** The registered scheduled job that drives the stream, or null when no job is registered for it. */
  cronSlug: string | null
  source: ReadSyncSource
  maxAge: ReadSyncMaxAge
  /** How often the stream is expected to complete, in operator words. */
  cadence: string
  /** What counts as a success, in operator words. A run that legitimately found nothing new counts. */
  successMeans: string
  /** Why the limit is what it is. */
  rationale: string
  /** Who raises the alarm for this stream. */
  alarm: 'read-sync-liveness' | 'wms-watchdog'
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** A binding is stale after this many of its own sync intervals... */
export const BINDING_STALE_INTERVALS = 3
/** ...but never sooner than this floor. */
export const BINDING_STALE_FLOOR_MS = HOUR_MS

/** The age at which a stock-sync binding of this cadence is stale. The ONE statement of the rule. */
export function bindingStaleAfterMs(syncFrequencyMinutes: number): number {
  const interval = Math.max(syncFrequencyMinutes, 1) * MINUTE_MS
  return Math.max(interval * BINDING_STALE_INTERVALS, BINDING_STALE_FLOOR_MS)
}

/** The stamp written by a clean WooCommerce order sweep, in the same transaction as its cursor. */
export const WC_ORDER_SWEEP_LAST_SUCCESS_SETTING = 'wc_order_sweep_last_success_at'
/** The stamp written at the end of an order-status refresh that read every order it chose without an error. */
export const WMS_ORDER_STATUS_LAST_SUCCESS_SETTING = 'wms_order_status_sweep_last_success_at'
/** The stamp written, with the snapshots, by a scheduled balance-snapshot pull that stored every configured account. */
export const XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING = 'xero_balance_snapshot_last_success_at'
/** The stamp the Xero tax-rate read has always written, after its snapshot, inside one connection-fenced transaction. */
export const XERO_TAX_RATE_LAST_SUCCESS_SETTING = 'xero_tax_rate_drift_last_checked_at'

/** When the alarm job first evaluated; a stream that has never succeeded is only alarmed once the limit has run since. */
export const READ_SYNC_FIRST_EVALUATED_SETTING = 'read_sync_liveness_first_evaluated_at'
export const READ_SYNC_ALERTED_SETTING_PREFIX = 'read_sync_liveness_alerted_'

export function readSyncAlertedSettingKey(stream: ReadSyncStreamId): string {
  return `${READ_SYNC_ALERTED_SETTING_PREFIX}${stream.replace(/-/g, '_')}`
}

/** Every settings key this feature owns, for the reset path and the tests. */
export const READ_SYNC_OWNED_SETTING_KEYS: readonly string[] = [
  WC_ORDER_SWEEP_LAST_SUCCESS_SETTING,
  WMS_ORDER_STATUS_LAST_SUCCESS_SETTING,
  XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING,
  READ_SYNC_FIRST_EVALUATED_SETTING,
  ...READ_SYNC_STREAM_IDS.map(readSyncAlertedSettingKey),
]

export const READ_SYNC_STREAMS: readonly ReadSyncStreamDef[] = [
  {
    id: 'woocommerce-order-sweep',
    label: 'WooCommerce order sweep',
    plugin: 'woocommerce',
    cronSlug: 'wc-reconcile',
    source: { kind: 'setting', key: WC_ORDER_SWEEP_LAST_SUCCESS_SETTING },
    maxAge: { kind: 'fixed', ms: 72 * HOUR_MS },
    cadence: 'daily (the wc-reconcile job; while webhooks are primary the reconcile only runs when 24 hours have passed since the last one, so a daily job completes it every one to two days)',
    successMeans: 'the sweep read WooCommerce to an empty page, imported or skipped every order it returned without an error, and advanced its cursor; a sweep that found no new orders counts',
    rationale: 'two days is the longest healthy gap (a daily job whose 24 hour check lands just short of a day skips one run), and a third day is the first one that is not explained by that',
    alarm: 'read-sync-liveness',
  },
  {
    id: 'mintsoft-stock-sync',
    label: 'Mintsoft stock sync',
    plugin: 'mintsoft',
    cronSlug: 'mintsoft-stock-sync',
    source: { kind: 'binding-column', column: 'lastStockSyncSuccessAt' },
    maxAge: { kind: 'binding-cadence' },
    cadence: "each binding's own sync frequency (default hourly)",
    successMeans: 'the sync read the warehouse stock for the binding and finished its checks (a run with some per-line errors counts as completed, a run that could not read the warehouse does not)',
    rationale: `${BINDING_STALE_INTERVALS} of the binding's own intervals and never less than 1 hour, the rule the WMS watchdog has always applied`,
    alarm: 'wms-watchdog',
  },
  {
    id: 'mintsoft-dispatch-poll',
    label: 'Mintsoft despatch poll',
    plugin: 'mintsoft',
    cronSlug: 'mintsoft-dispatch-sync',
    source: { kind: 'sync-job', connector: 'mintsoft', jobType: 'DISPATCH_SYNC' },
    maxAge: { kind: 'fixed', ms: 2 * HOUR_MS },
    cadence: 'every 15 minutes (the mintsoft-dispatch-sync job; on by default)',
    successMeans: 'the poll finished with job status SUCCEEDED, which excludes a poll that degraded (a failed delta read, unresolved orders, an unreadable withdrawal screen); a poll with nothing to check counts',
    rationale: 'eight missed 15 minute polls, long enough to ride out a short Mintsoft outage and short enough to matter on a day of trading',
    alarm: 'read-sync-liveness',
  },
  {
    id: 'mintsoft-order-status',
    label: 'Mintsoft order-status refresh',
    plugin: 'mintsoft',
    cronSlug: 'wms-order-status',
    source: { kind: 'setting', key: WMS_ORDER_STATUS_LAST_SUCCESS_SETTING },
    maxAge: { kind: 'fixed', ms: 2 * HOUR_MS },
    cadence: 'every 15 minutes (the wms-order-status job; off by default)',
    successMeans: 'the refresh resolved a connector and a lookup source and read every order it selected without an error; a refresh with no stale orders to read counts, a refresh that was skipped does not',
    rationale: 'eight missed 15 minute runs, the same reasoning as the despatch poll',
    alarm: 'read-sync-liveness',
  },
  {
    id: 'xero-balance-snapshots',
    label: 'Xero balance-snapshot pull',
    plugin: 'xero',
    cronSlug: 'account-balance-snapshot',
    source: { kind: 'setting', key: XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING },
    maxAge: { kind: 'fixed', ms: 36 * HOUR_MS },
    cadence: 'daily at 01:00 (the account-balance-snapshot job)',
    successMeans: 'the scheduled pull read the Xero trial balance and stored a snapshot for every configured account without an error; an on-demand refresh for one date or one account does not count',
    rationale: 'a day and a half: one missed daily run is the first thing that is not explained by the schedule',
    alarm: 'read-sync-liveness',
  },
  {
    id: 'xero-tax-rates',
    label: 'Xero tax-rate read',
    plugin: 'xero',
    cronSlug: 'xero-tax-rate-drift',
    source: { kind: 'setting', key: XERO_TAX_RATE_LAST_SUCCESS_SETTING },
    maxAge: { kind: 'fixed', ms: 6 * HOUR_MS },
    cadence: 'hourly (the xero-tax-rate-drift job)',
    successMeans: 'the sweep read the Xero tax rates (or found no IMS tax rates to compare) and stored its result; a sweep that found no drift counts',
    rationale: 'six missed hourly runs, long enough to ride out a Xero outage or rate-limit window',
    alarm: 'read-sync-liveness',
  },
]

export function getReadSyncStream(id: ReadSyncStreamId): ReadSyncStreamDef {
  const found = READ_SYNC_STREAMS.find((stream) => stream.id === id)
  if (!found) throw new Error(`unknown read-sync stream ${id}`)
  return found
}

/** The age limit of a stream with a fixed limit. A binding-cadence stream asks bindingStaleAfterMs instead. */
export function fixedMaxAgeMs(stream: ReadSyncStreamDef): number | null {
  return stream.maxAge.kind === 'fixed' ? stream.maxAge.ms : null
}

// ---------------------------------------------------------------------------------------------
// The status command
// ---------------------------------------------------------------------------------------------

/** Version of the `read-sync:status --json` document. Consumers (the go/no-go gate) require it. */
export const READ_SYNC_STATUS_SCHEMA_VERSION = 1
export const READ_SYNC_STATUS_COMMAND = 'npm run read-sync:status'
export const READ_SYNC_ALARM_CRON_SLUG = 'read-sync-liveness'
export const READ_SYNC_ALERT_ACTION = 'read_sync_stream_stale'

export type ReadSyncStatusExitCode = { code: number; name: string; meaning: string }

/** The exit code is the FIRST row of this array whose condition holds; array order is precedence. */
export const READ_SYNC_STATUS_EXIT_CODES: readonly ReadSyncStatusExitCode[] = [
  { code: 5, name: 'failed', meaning: 'the report could not be produced because of an unexpected error; no stream was evaluated' },
  { code: 3, name: 'usage', meaning: 'an unknown argument was given; nothing was evaluated' },
  { code: 1, name: 'stale', meaning: 'at least one stream that is switched on last succeeded longer ago than its limit (or has a last-success time in the future, which is not believed)' },
  { code: 6, name: 'unscheduled', meaning: 'a job this report depends on is switched off, or enabled but without an active entry the scheduler would write in a complete managed crontab block (the alarm job, the job behind a stream that is switched on, and the wms-watchdog job while the stock sync is in play), or the crontab could not be read; a newly registered job is only scheduled by Settings > System > Scheduler > Save & Apply; no stream is stale' },
  { code: 2, name: 'never', meaning: 'at least one stream that is switched on has no successful run recorded; no stream is stale' },
  { code: 4, name: 'off', meaning: 'at least one stream is switched off or cannot run (plugin disabled, scheduled job disabled, not connected, no active binding), so it is not keeping IMS current; no stream that is switched on is stale, without a success or unscheduled' },
  { code: 0, name: 'ok', meaning: 'every stream is switched on and last succeeded within its limit' },
]

export function renderReadSyncStatusExitCodeTable(): string {
  const rows = [...READ_SYNC_STATUS_EXIT_CODES]
    .sort((left, right) => left.code - right.code)
    .map((row) => `| ${row.code} | ${row.name} | ${row.meaning} |`)
  return ['| Exit code | Name | Meaning |', '|---|---|---|', ...rows].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Operator text
// ---------------------------------------------------------------------------------------------

export function formatReadSyncAge(ms: number): string {
  const totalMinutes = Math.floor(ms / MINUTE_MS)
  if (totalMinutes < 120) return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`
  const totalHours = Math.floor(ms / HOUR_MS)
  if (totalHours < 72) return `${totalHours} hours`
  return `${Math.floor(totalHours / 24)} days`
}

export type ReadSyncAlertInput = {
  stream: ReadSyncStreamId
  state: 'stale' | 'never'
  /** ISO time of the last recorded success; null for 'never'. */
  lastSuccessAt: string | null
  maxAgeMs: number
  /** ISO time liveness tracking began, for 'never'. */
  trackedSince: string | null
  /** True when the recorded time is in the future of the clock that read it. */
  futureTimestamp?: boolean
}

/**
 * The notification an admin reads. It states only what the stamp shows: the last time a clean run was
 * RECORDED, never that nothing has run or that nothing was fetched. It names the consequence as a
 * possibility, and the next look as a check, not an instruction to change anything.
 */
export function buildReadSyncAlert(input: ReadSyncAlertInput): { title: string; message: string } {
  const def = getReadSyncStream(input.stream)
  const limit = formatReadSyncAge(input.maxAgeMs)
  const consequence = 'IMS may be out of date for this feed, and a comparison or reconciliation run now may be measuring old data rather than IMS itself.'
  const check = `Check the scheduled job and the ${def.plugin === 'woocommerce' ? 'WooCommerce' : def.plugin === 'mintsoft' ? 'Mintsoft' : 'Xero'} connection (run ${READ_SYNC_STATUS_COMMAND} for every feed).`
  if (input.state === 'never') {
    const since = input.trackedSince ? ` since liveness tracking began on ${input.trackedSince.slice(0, 10)}` : ''
    return {
      title: `${def.label}: no successful run recorded`,
      message: `No successful run of the ${def.label.toLowerCase()} has been recorded${since} (limit ${limit}). ${consequence} ${check}`,
    }
  }
  const last = input.lastSuccessAt ?? 'unknown'
  const future = input.futureTimestamp ? ' The recorded time is later than the clock of the server that read it, so it is not believed.' : ''
  return {
    title: `${def.label}: no successful run within ${limit}`,
    message: `The ${def.label.toLowerCase()} last recorded a successful run at ${last} (limit ${limit}).${future} ${consequence} ${check}`,
  }
}

// ---------------------------------------------------------------------------------------------
// Documentation blocks
// ---------------------------------------------------------------------------------------------

export const READ_SYNC_DOC_BLOCK_OPEN = (id: string) => `<!-- read-sync-liveness:${id} -->`
export const READ_SYNC_DOC_BLOCK_CLOSE = (id: string) => `<!-- /read-sync-liveness:${id} -->`

export type ReadSyncDocBlockId = 'overview' | 'streams' | 'status-command'

function limitText(stream: ReadSyncStreamDef): string {
  return stream.maxAge.kind === 'fixed' ? formatReadSyncAge(stream.maxAge.ms) : `${BINDING_STALE_INTERVALS} sync intervals, at least ${formatReadSyncAge(BINDING_STALE_FLOOR_MS)}`
}

const STREAM_ROWS = READ_SYNC_STREAMS.map(
  (stream) => `| ${stream.label} | ${stream.cadence} | ${stream.successMeans} | ${limitText(stream)} (${stream.rationale}) | ${stream.alarm === 'wms-watchdog' ? 'WMS watchdog' : 'read-sync-liveness job'} |`,
)

export const READ_SYNC_DOC_BLOCKS: Record<ReadSyncDocBlockId, string> = {
  overview: [
    'During a parallel run IMS only reads from WooCommerce, Mintsoft and Xero, and a feed that has stopped looks exactly like a feed that has nothing new to say. So every read feed records the time of its last SUCCESSFUL run, separately from the time of its last attempt (an attempt that failed does not move it, and a run that legitimately found nothing new does), and a feed whose last success is older than its limit is reported as stale. A stale feed means the data IMS holds from that source may be old; it does not show that any record is wrong.',
    '',
    `The \`${READ_SYNC_ALARM_CRON_SLUG}\` scheduled job (hourly, on by default) raises an admin notification and a WARNING activity entry once per breach for every feed except the Mintsoft stock sync, whose alert is raised by the existing \`wms-watchdog\` job. A feed that has never recorded a success is only alarmed once its limit has passed since the job first ran, so a fresh deployment does not alarm for a feed that has not yet had its first scheduled run.`,
  ].join('\n'),
  streams: [
    '| Feed | Expected cadence | Counts as a success when | Stale after | Alarm raised by |',
    '|---|---|---|---|---|',
    ...STREAM_ROWS,
  ].join('\n'),
  'status-command': [
    `\`${READ_SYNC_STATUS_COMMAND}\` prints every feed with its state (fresh, stale, never succeeded, or off), the time of its last recorded success, its age and its limit. It reads the database only, makes no network call and writes nothing. It also checks that the scheduled jobs it depends on are switched on and have an active entry, exactly as the scheduler would write it, in a complete managed crontab block of the user it runs as (run it as the application user). That covers the alarm job, the job behind each feed that is switched on, and the WMS watchdog while the Mintsoft stock sync is in play. A newly registered job, including the alarm job itself on an upgraded installation, is only scheduled once Settings > System > Scheduler > Save & Apply has been used, and an alarm job that is not scheduled can never alarm. Pass \`--json\` for a machine-readable report: a JSON object whose \`schemaVersion\` is ${READ_SYNC_STATUS_SCHEMA_VERSION} and whose \`generatedAt\` is the ISO time the report was made, followed by the entries (each with \`ageMs\`, \`lastSuccessAt\`, \`futureTimestamp\`), the \`counts\`, the \`scheduler\` check and the \`exitCode\`. A feed is "off" when its plugin or scheduled job is disabled, the connector is not connected, or there is no active binding; an off feed is not keeping IMS current, so it is reported rather than hidden.`,
    '',
    renderReadSyncStatusExitCodeTable(),
  ].join('\n'),
}

/** Where each block is placed, so the docs test can require each exactly once and nothing else. */
export const READ_SYNC_DOC_PLACEMENTS: ReadonlyArray<{ file: string; blocks: readonly ReadSyncDocBlockId[] }> = [
  { file: 'docs/installation.md', blocks: ['overview', 'streams', 'status-command'] },
]
