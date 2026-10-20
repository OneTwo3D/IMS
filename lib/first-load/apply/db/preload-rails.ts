/**
 * THE PRE-LOAD RAILS: nothing that could write OUTSIDE the database may be armed while the first load runs.
 *
 * The first load runs with the application STOPPED. A database-wide write fence is out of scope: the quiesce rail (rails.ts) is the enforced part for the database. These four rails cover
 * what the quiesce rail cannot see, and each one is READ ONLY and FAILS CLOSED (a value that cannot be read is a refusal, never "fine"):
 *
 *   outbound-grants  an outbound write grant (WC_WRITEBACK_ALLOWED_ORIGIN, MINTSOFT_WRITE_ALLOWED, XERO_WRITE_ALLOWED_TENANT) is present in the installation environment, readable or not;
 *   producer-hold    PRODUCER_HOLD_ENFORCED_DESTINATIONS is unreadable, or a destination is not in the agreed HELD state (a grant, or a live-from instant, set). The state is REPORTED either way;
 *   connectors       a connector is enabled with a credential that could write (the storefront with its URL and keys, the warehouse connector with a credential or an active connection,
 *                    the accounting connector with a token or a client secret);
 *   crons            the crontab of the account running the load holds an active scheduled-job line that is not on the short list of jobs that never write, or one that cannot be classified.
 *
 * They are evaluated before the restore point is taken (the command), before the first step, at the start of every step and before its first write (the ports).
 *
 * WHAT THEY DO NOT PROVE. They read this account's crontab and the settings and tokens of THE DATABASE; they cannot see another account's crontab, a cron.d file, a process that is
 * already running, or an environment that is not in the file this command was given. The application must still be stopped (docs/first-load-apply.md).
 *
 * Problem text names a rail, a closed connector label and a count: never a value of the environment, a setting, a credential or a crontab line.
 */
import { renderCronJobCommand, runtimeSecretPrefix } from '@/lib/crontab-sync'
import { INTEGRATION_PLUGIN_EXCLUSIVITY_GROUPS, INTEGRATION_PLUGIN_SETTING_KEYS } from '@/lib/integration-plugin-keys'
import type { IntegrationPluginId } from '@/lib/integration-plugin-keys'
import { OUTBOUND_CONNECTORS, OUTBOUND_CONNECTOR_LABEL, OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { readOutboundGrantStates } from '@/lib/security/outbound-write-grant'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'
import { parseProducerCutoff, producerGrantCutoffAgreement } from '@/lib/security/producer-disposition'
import { readProducerEnforcement } from '@/lib/security/producer-seam'
import type { RailId } from '../constants'
import { ObservationError } from '../residual'
import { DATABASE_READ_FAILED } from './observe'

export type PreloadEnv = Readonly<Record<string, string | undefined>>

/** What one rail found: the refusals (text safe to print) and, for the producer hold, the state it read. */
export interface PreloadFinding {
  rail: RailId
  problems: string[]
  /** A closed description of the state read; empty when there is nothing to add. */
  detail: string
}

const hasOwn = Object.prototype.hasOwnProperty
const read = (env: PreloadEnv, name: string): string | undefined => (hasOwn.call(env, name) ? env[name] : undefined)

// ---------------------------------------------------------------------------
// outbound-grants
// ---------------------------------------------------------------------------

/** A grant present for any destination refuses, and so does a grant variable that is set but cannot be read. The value is never printed. */
export function outboundGrantFinding(env: PreloadEnv): PreloadFinding {
  const problems: string[] = []
  for (const state of readOutboundGrantStates({ ...env })) {
    const label = OUTBOUND_CONNECTOR_LABEL[state.connector]
    if (state.state === 'granted') problems.push(`outbound grants: a write grant for ${label} is present in the installation environment`)
    else if (state.state === 'unreadable') problems.push(`outbound grants: the grant variable for ${label} is set but cannot be read`)
  }
  // An unknown shape is refused, not skipped: a variable that looks like a grant, a live-from instant or the enforcement switch but is not spelled exactly as one (another case, a prefix, a
  // suffix) is not read by the transport today, and is exactly the thing a later release or a wrapper could start reading. Counted, never named.
  const known = new Set<string>([...Object.values(OUTBOUND_GRANT_ENV), ...Object.values(PRODUCER_CUTOFF_ENV), PRODUCER_HOLD_ENFORCED_ENV])
  const lookalikes = Object.keys(env).filter((name) => !known.has(name) && /(?:WRITEBACK|WRITE_ALLOWED|WRITES_LIVE_FROM|PRODUCER_HOLD)/i.test(name)).length
  if (lookalikes > 0) problems.push(`outbound grants: ${lookalikes} environment variable(s) look like an outbound grant, live-from instant or producer-hold switch but are not spelled as one the application reads`)
  return { rail: 'outbound-grants', problems, detail: problems.length === 0 ? `no write grant for ${OUTBOUND_CONNECTORS.length} destination(s)` : '' }
}

// ---------------------------------------------------------------------------
// producer-hold
// ---------------------------------------------------------------------------

/**
 * The producer-hold state, reported, and refused unless it is consistent and held. PRODUCER_HOLD_ENFORCED_DESTINATIONS is OFF by default and turned ON at the switchover: either
 * is accepted for the load, because the load produces no work for any destination (its effects are deferred, and the verification proves the outboxes did not grow). What is refused:
 * an enforcement value that cannot be read, and any destination that could receive writes from the load, meaning a grant or a live-from instant set, or the two disagreeing.
 */
export function producerHoldFinding(env: PreloadEnv): PreloadFinding {
  const problems: string[] = []
  const enforcement = readProducerEnforcement({ ...env })
  if (enforcement.enforced && !enforcement.readable) problems.push('producer hold: the enforcement variable is set but cannot be read, so every destination is treated as enforced')
  let held = 0
  for (const connector of OUTBOUND_CONNECTORS) {
    const label = OUTBOUND_CONNECTOR_LABEL[connector]
    const cutoff = parseProducerCutoff(read(env, PRODUCER_CUTOFF_ENV[connector]))
    const agreement = producerGrantCutoffAgreement(connector, { ...env })
    if (cutoff.ok) problems.push(`producer hold: a live-from instant is set for ${label}, so it could receive writes`)
    else if (cutoff.reason === 'unreadable') problems.push(`producer hold: the live-from variable for ${label} is set but cannot be read`)
    if (agreement.state === 'inconsistent') problems.push(`producer hold: the grant and the live-from instant for ${label} disagree`)
    else if (agreement.state === 'agreed_held') held += 1
  }
  const state = !enforcement.enforced ? 'enforcement OFF (the default)' : enforcement.readable ? `enforcement ON for ${[...enforcement.destinations].filter((d) => OUTBOUND_CONNECTORS.includes(d)).length} destination(s)` : 'enforcement UNREADABLE'
  return { rail: 'producer-hold', problems, detail: `${state}; ${held} of ${OUTBOUND_CONNECTORS.length} destination(s) agreed held` }
}

// ---------------------------------------------------------------------------
// connectors
// ---------------------------------------------------------------------------

/** The setting rows that make a storefront connector able to write, a warehouse connector able to write, and an accounting connector able to write. */
export const STOREFRONT_CREDENTIAL_KEYS = ['wc_url', 'wc_consumer_key', 'wc_consumer_secret'] as const
export const WAREHOUSE_CREDENTIAL_KEYS = ['mintsoft_api_key', 'mintsoft_static_api_key', 'mintsoft_username', 'mintsoft_password'] as const
export const ACCOUNTING_CREDENTIAL_KEYS = ['xero_client_secret'] as const
/** A setting that is also read from the environment when its row is empty (lib/settings-store.ts SETTING_ENV_FALLBACKS), for the keys above. */
export const CREDENTIAL_ENV_FALLBACKS: Readonly<Record<string, string>> = {
  mintsoft_api_key: 'MINTSOFT_API_KEY',
  mintsoft_static_api_key: 'MINTSOFT_STATIC_API_KEY',
  mintsoft_username: 'MINTSOFT_USERNAME',
  mintsoft_password: 'MINTSOFT_PASSWORD',
}

export interface ConnectorSnapshot {
  pluginEnabled: { woocommerce: boolean; mintsoft: boolean; xero: boolean }
  /** Which credential rows hold a non-empty value (the value itself is never read into this record). */
  credentialPresent: Readonly<Record<string, boolean>>
  accountingTokens: number
  activeWarehouseConnections: number
  activeWarehouseBindings: number
}

export function connectorFinding(snapshot: ConnectorSnapshot): PreloadFinding {
  const problems: string[] = []
  const has = (key: string): boolean => snapshot.credentialPresent[key] === true
  if (snapshot.pluginEnabled.woocommerce && STOREFRONT_CREDENTIAL_KEYS.every(has)) problems.push('connectors: the WooCommerce connector is enabled with store credentials, so it could write')
  const warehouseCredential = WAREHOUSE_CREDENTIAL_KEYS.some(has)
  if (snapshot.pluginEnabled.mintsoft && (warehouseCredential || snapshot.activeWarehouseConnections > 0 || snapshot.activeWarehouseBindings > 0)) {
    problems.push(`connectors: the Mintsoft connector is enabled with ${warehouseCredential ? 'a credential' : 'no credential'}, ${snapshot.activeWarehouseConnections} active connection(s) and ${snapshot.activeWarehouseBindings} active warehouse binding(s), so it could write`)
  }
  if (snapshot.pluginEnabled.xero && (snapshot.accountingTokens > 0 || ACCOUNTING_CREDENTIAL_KEYS.some(has))) problems.push(`connectors: the Xero connector is enabled with ${snapshot.accountingTokens} stored token(s) or a client secret, so it could write`)
  const enabled = (['woocommerce', 'mintsoft', 'xero'] as const).filter((id) => snapshot.pluginEnabled[id]).length
  return { rail: 'connectors', problems, detail: `${enabled} of 3 connector(s) enabled; ${problems.length} could write` }
}

/** Read the snapshot. Any read that fails is an ObservationError (refusal), never an empty snapshot. */
export async function readConnectorSnapshot(env: PreloadEnv): Promise<ConnectorSnapshot> {
  try {
    const { db } = await import('@/lib/db')
    const keys = [...Object.values(INTEGRATION_PLUGIN_SETTING_KEYS), ...STOREFRONT_CREDENTIAL_KEYS, ...WAREHOUSE_CREDENTIAL_KEYS, ...ACCOUNTING_CREDENTIAL_KEYS]
    const rows = await db.setting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } })
    const settings = new Map(rows.map((row) => [row.key, row.value]))
    const pluginKeys = await import('@/lib/integration-plugin-keys')
    // Only the exact text 'true' enables a plugin in the application; anything else that is not blank or exactly 'false' is a value this rail does not understand, and is read as ENABLED (refuse).
    const enabledOf = (id: IntegrationPluginId): boolean => {
      const raw = settings.get(pluginKeys.INTEGRATION_PLUGIN_SETTING_KEYS[id])
      return raw !== undefined && raw.trim() !== '' && raw.trim() !== 'false'
    }
    const state = pluginKeys.buildIntegrationPluginState(enabledOf)
    // Every registered warehouse connector id (the exclusivity group the plugin keys derive from the registry), not one named id.
    const warehouseIds = INTEGRATION_PLUGIN_EXCLUSIVITY_GROUPS.find((group) => group.label === 'wms')?.ids ?? []
    if (warehouseIds.length === 0) throw new Error('no warehouse connector ids')
    const warehouseEnabled = warehouseIds.some((id) => state[id] === true)
    const credentialPresent: Record<string, boolean> = {}
    for (const key of [...STOREFRONT_CREDENTIAL_KEYS, ...WAREHOUSE_CREDENTIAL_KEYS, ...ACCOUNTING_CREDENTIAL_KEYS]) {
      const stored = (settings.get(key) ?? '').trim()
      const fallback = CREDENTIAL_ENV_FALLBACKS[key]
      // The stored value is JSON text for a plain setting and an envelope for a secret: any non-empty stored text other than the empty JSON string counts as present.
      credentialPresent[key] = (stored !== '' && stored !== '""') || (fallback !== undefined && (read(env, fallback) ?? '').trim() !== '')
    }
    const [accountingTokens, activeWarehouseConnections, activeWarehouseBindings] = await Promise.all([
      db.accountingToken.count(),
      db.wmsConnection.count({ where: { active: true } }),
      db.externalWmsBinding.count({ where: { active: true } }),
    ])
    return { pluginEnabled: { woocommerce: state.woocommerce === true, mintsoft: warehouseEnabled, xero: state.xero === true }, credentialPresent, accountingTokens, activeWarehouseConnections, activeWarehouseBindings }
  } catch {
    throw new ObservationError(DATABASE_READ_FAILED)
  }
}

// ---------------------------------------------------------------------------
// crons
// ---------------------------------------------------------------------------

/** The scheduled jobs that never write to the database or to a destination (a read-only check, or a file backup). A test keeps each slug registered. */
export const READ_ONLY_CRON_SLUGS: readonly string[] = ['backup', 'writers-check', 'read-sync-liveness']

/**
 * AN ALLOWLIST, NOT A DENYLIST. A crontab line is harmless to the load only if it is PROVEN to be one of two things:
 *   - an environment assignment (`NAME=value`), which runs nothing; or
 *   - a schedule followed by a command that is, character for character, the line the application itself generates for one of the read-only jobs
 *     (`renderCronJobCommand`, with the runtime-secret prefix or without it, any env-file and log path made of ordinary characters and no quote).
 * Every other active line (a comment is the only other thing that is not active) is REFUSED, counted and never described: an arbitrary command, two commands on a line, a continued
 * line, a command with extra arguments, a legacy bearer-on-the-command-line line, an `@reboot` line that is not one of the above, a case variant. The command is matched whole, so
 * a read-only job followed by anything else is not that job.
 */
const SCHEDULE = '(?:@(?:reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|(?:\\*|(?:\\*/)?[0-9]+(?:[,-][0-9]+)*)(?:[ \\t]+(?:\\*|(?:\\*/)?[0-9]+(?:[,-][0-9]+)*)){4})'
const PATH_CLASS = "[^'%\\u0000-\\u001f\\u007f]+"
const ENV_SENTINEL = 'ZZENVPATHZZ'
const LOG_SENTINEL = 'ZZLOGPATHZZ'
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One anchored pattern per (read-only slug, secret mode), built from the application's own renderer so that the two cannot drift. */
export const ALLOWED_JOB_COMMANDS: readonly RegExp[] = READ_ONLY_CRON_SLUGS.flatMap((slug) => [runtimeSecretPrefix(ENV_SENTINEL), ''].map((prefix) => {
  const command = renderCronJobCommand({ prefix, slug, logPath: LOG_SENTINEL })
  return new RegExp(`^${escapeRegex(command).replace(escapeRegex(ENV_SENTINEL), PATH_CLASS).replace(escapeRegex(LOG_SENTINEL), PATH_CLASS)}$`)
}))
const JOB_LINE = new RegExp(`^(${SCHEDULE})[ \\t]+(\\S[\\s\\S]*)$`)
const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/

export interface CrontabJobLines {
  /** Active job lines proven to be one of the read-only jobs. */
  allowed: number
  /** Environment assignments (they run nothing). */
  environment: number
  /** Every other active line: refused. */
  refused: number
}

/** Classify the ACTIVE lines of a crontab text. Only a line whose first non-blank character is `#`, or a blank one, is inactive. Nothing of a line is returned. */
export function classifyCrontabText(text: string): CrontabJobLines {
  const out: CrontabJobLines = { allowed: 0, environment: 0, refused: 0 }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[ \t\r]+$/, '').replace(/^[ \t]+/, '')
    if (line === '' || line.startsWith('#')) continue
    if (ENV_LINE.test(line) && !line.endsWith('\\')) { out.environment += 1; continue }
    const job = JOB_LINE.exec(line)
    if (job !== null && ALLOWED_JOB_COMMANDS.some((pattern) => pattern.test(job[2]!))) out.allowed += 1
    else out.refused += 1
  }
  return out
}

export type CrontabRead = { resolved: true; text: string } | { resolved: false }

export function cronFinding(read: CrontabRead): PreloadFinding {
  if (!read.resolved) return { rail: 'crons', problems: ['crons: the crontab of the account running the load could not be read, and an unreadable crontab is not an empty one'], detail: '' }
  const lines = classifyCrontabText(read.text)
  const problems: string[] = []
  if (lines.refused > 0) problems.push(`crons: ${lines.refused} active crontab line(s) are not proven to be one of the read-only jobs (backup, writers-check, read-sync-liveness) or an environment assignment; remove or comment them before the load`)
  return { rail: 'crons', problems, detail: `${lines.allowed} read-only job line(s), ${lines.environment} environment line(s), ${lines.refused} refused` }
}

/**
 * The crontab of the account running this process, read by the application's own reader (`readOwnCrontabResult`, lib/crontab-reconcile.ts), which fails closed: only the single benign
 * answer "no crontab for <user>" is an empty crontab, and every other failure is unresolved. It is the one `crontab -l` caller in the application (a census test keeps it so), so this rail
 * does not carry a second copy of the rule. The reader's reason text (the child's stderr) is dropped here: it is not ours to print.
 */
export async function readCrontabViaApplicationReader(): Promise<CrontabRead> {
  const { readOwnCrontabResult } = await import('@/lib/crontab-reconcile')
  const read = await readOwnCrontabResult()
  return read.resolved ? { resolved: true, text: read.text } : { resolved: false }
}

// ---------------------------------------------------------------------------
// The four, together
// ---------------------------------------------------------------------------

/** The readers, injectable so a test can drive every arm without a crontab or a database. The command passes none. */
export interface PreloadReaders {
  env: PreloadEnv
  connectors: (env: PreloadEnv) => Promise<ConnectorSnapshot>
  crontab: () => Promise<CrontabRead>
}

export const defaultPreloadReaders = (env: PreloadEnv): PreloadReaders => ({ env, connectors: readConnectorSnapshot, crontab: readCrontabViaApplicationReader })

export async function evaluatePreloadRails(readers: PreloadReaders): Promise<PreloadFinding[]> {
  const findings: PreloadFinding[] = [outboundGrantFinding(readers.env), producerHoldFinding(readers.env)]
  findings.push(connectorFinding(await readers.connectors(readers.env)))
  let crontab: CrontabRead
  try { crontab = await readers.crontab() } catch { crontab = { resolved: false } }
  findings.push(cronFinding(crontab))
  return findings
}
