/**
 * "IS IMS STAYING CURRENT?" - the report behind `npm run read-sync:status`, and the evaluation the
 * alarm job shares.
 *
 * Reads the database only (settings rows, stock-sync bindings, sync jobs) and makes no network call and
 * no write. `assembleReadSyncReport` is pure: it is handed everything it needs, so the tests drive it
 * directly, and `readReadSyncInputs` is the one function that touches the database.
 *
 * A stream that is switched off or cannot run is reported as `off` with the reason, never silently
 * dropped: a feed that is not running is not keeping IMS current, and the report is the place that has
 * to say so.
 */

import { resolveCronEnablement } from '@/lib/domain/settings/cron-enablement'
import { extractOtiBlock } from '@/lib/crontab-sync'

import {
  READ_SYNC_ALARM_CRON_SLUG,
  READ_SYNC_STATUS_EXIT_CODES,
  READ_SYNC_STREAMS,
  bindingStaleAfterMs,
  formatReadSyncAge,
  type ReadSyncStreamDef,
  type ReadSyncStreamId,
} from './read-sync-liveness-constants'
import { evaluateReadSyncStream, parseReadSyncStamp, type ReadSyncFreshness } from './read-sync-liveness'

export type ReadSyncState = ReadSyncFreshness | 'off'

export type ReadSyncBindingInput = {
  id: string
  warehouseCode: string
  syncFrequencyMinutes: number
  lastStockSyncSuccessAt: Date | null
}

export type ReadSyncInputs = {
  /** Raw settings rows by key, for the stamps and the enablement rows. */
  settings: ReadonlyMap<string, string>
  pluginEnabled: Record<'woocommerce' | 'mintsoft' | 'xero', boolean>
  xeroConnected: boolean
  /** Whether each registered scheduled job is on (canonical row, legacy row, then default). */
  cronEnabled: Readonly<Record<string, boolean>>
  /** Active stock-sync bindings of the Mintsoft connection that are not DISABLED. */
  bindings: readonly ReadSyncBindingInput[]
  /** finishedAt of the newest DISPATCH_SYNC job with status SUCCEEDED, or null. */
  lastDispatchSuccessAt: Date | null
  /**
   * The application user's crontab as read, or why it could not be. Absent = the scheduler was not
   * examined (tests that are about freshness alone).
   */
  crontab?: { resolved: true; text: string } | { resolved: false; reason: string }
}

export type ReadSyncSchedulerCheck = {
  examined: boolean
  /** Why the crontab could not be read, when it could not. */
  unreadable: string | null
  /** Enabled jobs this report depends on that have no managed crontab entry. */
  unscheduled: string[]
}

export type ReadSyncEntry = {
  stream: ReadSyncStreamId
  label: string
  /** The binding's warehouse for a per-binding stream; null otherwise. */
  instance: string | null
  state: ReadSyncState
  lastSuccessAt: string | null
  ageMs: number | null
  maxAgeMs: number | null
  futureTimestamp: boolean
  /** Why the stream is off, or a note about how it was read. */
  detail: string | null
  cadence: string
}

export type ReadSyncReport = {
  generatedAt: string
  entries: ReadSyncEntry[]
  counts: Record<ReadSyncState, number>
  scheduler: ReadSyncSchedulerCheck
}

function offEntry(def: ReadSyncStreamDef, detail: string, instance: string | null = null): ReadSyncEntry {
  return {
    stream: def.id,
    label: def.label,
    instance,
    state: 'off',
    lastSuccessAt: null,
    ageMs: null,
    maxAgeMs: null,
    futureTimestamp: false,
    detail,
    cadence: def.cadence,
  }
}

function evaluatedEntry(
  def: ReadSyncStreamDef,
  lastSuccessAt: Date | null,
  now: Date,
  maxAgeMs: number,
  instance: string | null = null,
  detail: string | null = null,
): ReadSyncEntry {
  const evaluation = evaluateReadSyncStream(def.id, lastSuccessAt, now, maxAgeMs)
  return {
    stream: def.id,
    label: def.label,
    instance,
    state: evaluation.state,
    lastSuccessAt: evaluation.lastSuccessAt ? evaluation.lastSuccessAt.toISOString() : null,
    ageMs: evaluation.ageMs,
    maxAgeMs,
    futureTimestamp: evaluation.futureTimestamp,
    detail,
    cadence: def.cadence,
  }
}

const PLUGIN_NAME = { woocommerce: 'WooCommerce', mintsoft: 'Mintsoft', xero: 'Xero' } as const

/** The slugs the managed crontab block calls. Pure. */
export function scheduledSlugsIn(crontabText: string): Set<string> {
  const slugs = new Set<string>()
  for (const line of extractOtiBlock(crontabText)) {
    if (line.trim().startsWith('#')) continue
    const match = line.match(/\$BASE_URL\/([a-z0-9-]+)"/)
    if (match) slugs.add(match[1]!)
  }
  return slugs
}

/**
 * Which enabled jobs does this report depend on, and are they in the crontab? The alarm job itself is
 * included: registering a job does not schedule it on an installation that already has a managed block,
 * and an alarm that is never called can never fire. Pure.
 */
export function checkScheduler(inputs: ReadSyncInputs): ReadSyncSchedulerCheck {
  if (!inputs.crontab) return { examined: false, unreadable: null, unscheduled: [] }
  if (!inputs.crontab.resolved) return { examined: true, unreadable: inputs.crontab.reason, unscheduled: [] }
  const present = scheduledSlugsIn(inputs.crontab.text)
  const wanted = new Set<string>()
  if (inputs.cronEnabled[READ_SYNC_ALARM_CRON_SLUG] === true) wanted.add(READ_SYNC_ALARM_CRON_SLUG)
  for (const def of READ_SYNC_STREAMS) {
    if (def.cronSlug && inputs.cronEnabled[def.cronSlug] === true && inputs.pluginEnabled[def.plugin]) wanted.add(def.cronSlug)
  }
  return { examined: true, unreadable: null, unscheduled: [...wanted].filter((slug) => !present.has(slug)).sort() }
}

/** Pure. Every stream in READ_SYNC_STREAMS yields at least one entry. */
export function assembleReadSyncReport(inputs: ReadSyncInputs, now: Date): ReadSyncReport {
  const entries: ReadSyncEntry[] = []

  for (const def of READ_SYNC_STREAMS) {
    if (!inputs.pluginEnabled[def.plugin]) {
      entries.push(offEntry(def, `the ${PLUGIN_NAME[def.plugin]} plugin is disabled`))
      continue
    }
    if (def.plugin === 'xero' && !inputs.xeroConnected) {
      entries.push(offEntry(def, 'Xero is not connected'))
      continue
    }
    if (def.cronSlug !== null && inputs.cronEnabled[def.cronSlug] !== true) {
      entries.push(offEntry(def, `the ${def.cronSlug} scheduled job is disabled`))
      continue
    }
    if (def.id === 'woocommerce-order-sweep' && inputs.settings.get('wc_sync_enabled') !== 'true') {
      entries.push(offEntry(def, 'WooCommerce sync is disabled (wc_sync_enabled is not true)'))
      continue
    }

    if (def.source.kind === 'binding-column') {
      if (inputs.bindings.length === 0) {
        entries.push(offEntry(def, 'there is no active Mintsoft stock-sync binding'))
        continue
      }
      for (const binding of inputs.bindings) {
        entries.push(
          evaluatedEntry(def, binding.lastStockSyncSuccessAt, now, bindingStaleAfterMs(binding.syncFrequencyMinutes), binding.warehouseCode),
        )
      }
      continue
    }

    if (def.maxAge.kind !== 'fixed') {
      throw new Error(`read-sync stream ${def.id} has a per-binding limit but no binding source`)
    }
    const lastSuccessAt = def.source.kind === 'setting'
      ? parseReadSyncStamp(inputs.settings.get(def.source.key))
      : inputs.lastDispatchSuccessAt
    const detail = def.source.kind === 'setting' && inputs.settings.has(def.source.key) && lastSuccessAt === null
      ? `the stored value of ${def.source.key} is not a time, so it is treated as no success recorded`
      : null
    entries.push(evaluatedEntry(def, lastSuccessAt, now, def.maxAge.ms, null, detail))
  }

  const counts: Record<ReadSyncState, number> = { fresh: 0, stale: 0, never: 0, off: 0 }
  for (const entry of entries) counts[entry.state] += 1
  return { generatedAt: now.toISOString(), entries, counts, scheduler: checkScheduler(inputs) }
}

function exitCode(name: string): number {
  const found = READ_SYNC_STATUS_EXIT_CODES.find((row) => row.name === name)
  if (!found) throw new Error(`read-sync status exit code ${name} is not in the table`)
  return found.code
}

/** The exit code, by the precedence of READ_SYNC_STATUS_EXIT_CODES (array order). */
export function readSyncStatusExitCode(report: ReadSyncReport): number {
  for (const row of READ_SYNC_STATUS_EXIT_CODES) {
    if (row.name === 'stale' && report.counts.stale > 0) return row.code
    if (row.name === 'unscheduled' && (report.scheduler.unscheduled.length > 0 || report.scheduler.unreadable !== null)) return row.code
    if (row.name === 'never' && report.counts.never > 0) return row.code
    if (row.name === 'off' && report.counts.off > 0) return row.code
  }
  return exitCode('ok')
}

export function renderReadSyncStatusText(report: ReadSyncReport): string {
  const lines: string[] = []
  const bad = report.counts.stale + report.counts.never + report.counts.off + report.scheduler.unscheduled.length + (report.scheduler.unreadable !== null ? 1 : 0)
  lines.push(
    bad === 0
      ? `CURRENT: all ${report.entries.length} read feeds last succeeded within their limits.`
      : `NOT PROVEN CURRENT: ${report.counts.stale} stale, ${report.counts.never} without a recorded success, ${report.counts.off} off, ${report.counts.fresh} fresh.`,
  )
  for (const entry of report.entries) {
    const name = entry.instance ? `${entry.label} (${entry.instance})` : entry.label
    const state = entry.state.toUpperCase().padEnd(5)
    if (entry.state === 'off') {
      lines.push(`  ${state} ${name} - ${entry.detail}`)
      continue
    }
    if (entry.state === 'never') {
      lines.push(`  ${state} ${name} - no successful run recorded (limit ${formatReadSyncAge(entry.maxAgeMs as number)})${entry.detail ? `; ${entry.detail}` : ''}`)
      continue
    }
    const age = entry.ageMs !== null && entry.ageMs >= 0 ? `${formatReadSyncAge(entry.ageMs)} ago` : 'in the future'
    const future = entry.futureTimestamp ? ' (later than this server clock, so not believed)' : ''
    lines.push(`  ${state} ${name} - last success ${entry.lastSuccessAt} (${age}${future}; limit ${formatReadSyncAge(entry.maxAgeMs as number)})`)
  }
  if (report.scheduler.unreadable !== null) {
    lines.push(`SCHEDULER NOT CHECKED: the crontab could not be read (${report.scheduler.unreadable}). Run this as the application user. Until it is read, whether the alarm job runs is not proven.`)
  }
  if (report.scheduler.unscheduled.length > 0) {
    lines.push(`UNSCHEDULED: ${report.scheduler.unscheduled.join(', ')} ${report.scheduler.unscheduled.length === 1 ? 'is' : 'are'} enabled but not in the managed crontab, so nothing calls ${report.scheduler.unscheduled.length === 1 ? 'it' : 'them'}. A job registered by an upgrade is only scheduled by Settings > System > Scheduler > Save & Apply.`)
  }
  lines.push('A stale or never-succeeded feed means the data IMS holds from that source may be old. It does not show that any record is wrong.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// The one reader that touches the database
// ---------------------------------------------------------------------------------------------

export async function readReadSyncInputs(): Promise<ReadSyncInputs> {
  const { db } = await import('@/lib/db')
  // Importing the registry module registers every job; the enablement of each is read from settings.
  await import('@/lib/cron-jobs')
  const { getAllCronJobs } = await import('@/lib/cron-registry')
  const { getIntegrationPluginState } = await import('@/lib/integration-plugins')
  const { isAccountingConnectorConnected } = await import('@/lib/accounting')

  const jobs = getAllCronJobs()
  const wantedKeys = new Set<string>(['wc_sync_enabled'])
  const alarmJob = jobs.find((candidate) => candidate.slug === READ_SYNC_ALARM_CRON_SLUG)
  if (alarmJob) wantedKeys.add(`cron_${alarmJob.settingKey}_enabled`)
  for (const def of READ_SYNC_STREAMS) {
    if (def.source.kind === 'setting') wantedKeys.add(def.source.key)
    const job = def.cronSlug ? jobs.find((candidate) => candidate.slug === def.cronSlug) : undefined
    if (job) {
      wantedKeys.add(`cron_${job.settingKey}_enabled`)
      if (job.legacyEnabledKey) wantedKeys.add(job.legacyEnabledKey)
    }
  }
  const rows = await db.setting.findMany({ where: { key: { in: [...wantedKeys] } }, select: { key: true, value: true } })
  const settings = new Map(rows.map((row) => [row.key, row.value]))

  const cronEnabled: Record<string, boolean> = {}
  for (const def of READ_SYNC_STREAMS) {
    if (!def.cronSlug) continue
    const job = jobs.find((candidate) => candidate.slug === def.cronSlug)
    // A stream whose job is not registered is reported as off, not assumed on.
    cronEnabled[def.cronSlug] = job
      ? resolveCronEnablement({
          canonical: settings.get(`cron_${job.settingKey}_enabled`),
          legacy: job.legacyEnabledKey ? settings.get(job.legacyEnabledKey) : undefined,
          hasLegacyKey: Boolean(job.legacyEnabledKey),
          defaultEnabled: job.defaultEnabled,
        })
      : false
  }

  cronEnabled[READ_SYNC_ALARM_CRON_SLUG] = alarmJob
    ? resolveCronEnablement({
        canonical: settings.get(`cron_${alarmJob.settingKey}_enabled`),
        legacy: undefined,
        hasLegacyKey: false,
        defaultEnabled: alarmJob.defaultEnabled,
      })
    : false

  // Read-only: `crontab -l` of the user this runs as. Nothing is written.
  const reconcileModule = await import('@/lib/crontab-reconcile') as unknown as {
    readOwnCrontabResult?: () => Promise<{ resolved: true; text: string } | { resolved: false; reason: string }>
    default?: { readOwnCrontabResult: () => Promise<{ resolved: true; text: string } | { resolved: false; reason: string }> }
  }
  // Under tsx a CommonJS-interop load exposes the exports on `default`; the bundled server has them named.
  const readOwnCrontabResult = reconcileModule.readOwnCrontabResult ?? reconcileModule.default!.readOwnCrontabResult
  const crontab = await readOwnCrontabResult()

  const state = await getIntegrationPluginState()
  const pluginEnabled = {
    woocommerce: state.woocommerce === true,
    mintsoft: state.mintsoft === true,
    xero: state.xero === true,
  }

  const bindings = await db.externalWmsBinding.findMany({
    where: { connector: 'mintsoft', active: true, connection: { active: true }, stockSyncMode: { not: 'DISABLED' } },
    select: { id: true, syncFrequencyMinutes: true, lastStockSyncSuccessAt: true, warehouse: { select: { code: true } } },
    orderBy: { createdAt: 'asc' },
  })

  const lastDispatch = await db.wmsSyncJob.findFirst({
    where: { connector: 'mintsoft', type: 'DISPATCH_SYNC', status: 'SUCCEEDED', finishedAt: { not: null } },
    orderBy: { finishedAt: 'desc' },
    select: { finishedAt: true },
  })

  return {
    settings,
    pluginEnabled,
    xeroConnected: pluginEnabled.xero ? await isAccountingConnectorConnected('xero') : false,
    cronEnabled,
    bindings: bindings.map((binding) => ({
      id: binding.id,
      warehouseCode: binding.warehouse.code,
      syncFrequencyMinutes: binding.syncFrequencyMinutes,
      lastStockSyncSuccessAt: binding.lastStockSyncSuccessAt,
    })),
    lastDispatchSuccessAt: lastDispatch?.finishedAt ?? null,
    crontab: crontab.resolved ? { resolved: true, text: crontab.text } : { resolved: false, reason: crontab.reason },
  }
}

export async function buildReadSyncStatusReport(deps: { now?: Date; readInputs?: () => Promise<ReadSyncInputs> } = {}): Promise<ReadSyncReport> {
  const now = deps.now ?? new Date()
  const inputs = await (deps.readInputs ?? readReadSyncInputs)()
  return assembleReadSyncReport(inputs, now)
}
