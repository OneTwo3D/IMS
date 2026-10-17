/**
 * "IS IMS WRITING TO ANYTHING?" - the report behind `npm run outbound:status`.
 *
 * Reads the ENVIRONMENT (the grants, via lib/security/outbound-write-grant.ts) and the ACTIVITY LOG
 * (the refusals the hold logged). Makes no network call and writes nothing. The words, names and the
 * exit-code table come from lib/security/outbound-write-hold-constants.ts and are documented there once.
 *
 * What a grant means is deliberately narrow: it says a write MAY leave for that destination. It does not
 * say a writer is enabled or has ever run, and the report says so rather than implying it.
 */

import {
  OUTBOUND_CONNECTORS,
  OUTBOUND_CONNECTOR_LABEL,
  OUTBOUND_HELD_ACTION,
  OUTBOUND_STATUS_EXIT_CODES,
  type OutboundConnector,
} from '@/lib/security/outbound-write-hold-constants'
import { readOutboundGrantStates, type OutboundEnv, type OutboundGrantState } from '@/lib/security/outbound-write-grant'
import {
  buildProducerStatus,
  derivePreCutoffTotal,
  PRODUCER_STATUS_WINDOW_HOURS,
  readProducerCountsFromDatabase,
  type OutboundProducerStatus,
} from '@/lib/ops/outbound-producer-status'

export const OUTBOUND_STATUS_WINDOW_HOURS = 24

export type OutboundRefusalRow = { createdAt: Date; metadata: unknown }

export type OutboundConnectorStatus = {
  connector: OutboundConnector
  label: string
  envName: string
  state: OutboundGrantState['state']
  destination: string | null
  detail: string | null
  /** Refused writes in the window; null when the activity log could not be read. */
  refusalsInWindow: number | null
  lastRefusalAt: string | null
}

export type OutboundStatusReport = {
  generatedAt: string
  windowHours: number
  connectors: OutboundConnectorStatus[]
  anyGranted: boolean
  anyUnreadable: boolean
  countsAvailable: boolean
  /** The producer-side half. Nothing in it is read, and nothing in it can change an exit code, unless the hold is enforced for a destination. */
  producer: OutboundProducerStatus
}

function refusalWeight(metadata: unknown): number {
  const suppressed = (metadata as { suppressedSinceLast?: unknown } | null)?.suppressedSinceLast
  return 1 + (typeof suppressed === 'number' && Number.isFinite(suppressed) && suppressed > 0 ? Math.trunc(suppressed) : 0)
}

function refusalConnector(metadata: unknown): string | null {
  const connector = (metadata as { connector?: unknown } | null)?.connector
  return typeof connector === 'string' ? connector : null
}

export async function readRecentOutboundRefusals(now: Date): Promise<OutboundRefusalRow[]> {
  const { db } = await import('@/lib/db')
  const since = new Date(now.getTime() - OUTBOUND_STATUS_WINDOW_HOURS * 3_600_000)
  const rows = await db.activityLog.findMany({
    where: { action: OUTBOUND_HELD_ACTION, createdAt: { gte: since } },
    select: { createdAt: true, metadata: true },
    orderBy: { createdAt: 'desc' },
    take: 100_000,
  })
  return rows
}

export async function buildOutboundStatusReport(deps: {
  env?: OutboundEnv
  now?: Date
  readRefusals?: (now: Date) => Promise<OutboundRefusalRow[]>
  readProducerCounts?: Parameters<typeof buildProducerStatus>[0]['readCounts']
} = {}): Promise<OutboundStatusReport> {
  const now = deps.now ?? new Date()
  const env = deps.env ?? process.env
  const states = readOutboundGrantStates(env)
  const producer = await buildProducerStatus({ env, now, readCounts: deps.readProducerCounts ?? readProducerCountsFromDatabase })

  let rows: OutboundRefusalRow[] | null = null
  try {
    rows = await (deps.readRefusals ?? readRecentOutboundRefusals)(now)
  } catch {
    rows = null
  }

  const connectors: OutboundConnectorStatus[] = OUTBOUND_CONNECTORS.map((connector) => {
    const state = states.find((candidate) => candidate.connector === connector) as OutboundGrantState
    const mine = rows === null ? null : rows.filter((row) => refusalConnector(row.metadata) === connector)
    return {
      connector,
      label: OUTBOUND_CONNECTOR_LABEL[connector],
      envName: state.envName,
      state: state.state,
      destination: state.state === 'granted' ? state.destination : null,
      detail: state.state === 'unreadable' ? state.detail : null,
      refusalsInWindow: mine === null ? null : mine.reduce((sum, row) => sum + refusalWeight(row.metadata), 0),
      lastRefusalAt: mine && mine.length > 0
        ? new Date(Math.max(...mine.map((row) => row.createdAt.getTime()))).toISOString()
        : null,
    }
  })

  return {
    generatedAt: now.toISOString(),
    windowHours: OUTBOUND_STATUS_WINDOW_HOURS,
    connectors,
    anyGranted: connectors.some((entry) => entry.state === 'granted'),
    anyUnreadable: connectors.some((entry) => entry.state === 'unreadable'),
    countsAvailable: rows !== null,
    producer,
  }
}

function exitCode(name: string): number {
  const found = OUTBOUND_STATUS_EXIT_CODES.find((row) => row.name === name)
  if (!found) throw new Error(`outbound status exit code ${name} is not in the table`)
  return found.code
}

/** The exit code, by the precedence of OUTBOUND_STATUS_EXIT_CODES (array order). */
export function outboundStatusExitCode(report: OutboundStatusReport, options: { expectHeld?: boolean } = {}): number {
  const producer = report.producer
  const enforced = producer.destinations.filter((entry) => entry.enforced)
  const producerUnreadable = producer.enforced && (!producer.enforcementReadable || enforced.some((entry) => entry.agreement === 'unreadable'))
  const anyLive = enforced.some((entry) => entry.liveOperations > 0)
  const preCutoff = enforced.some((entry) => entry.phase === 'P2' && derivePreCutoffTotal(entry.counts) > 0)
  const inconsistent = enforced.some((entry) => entry.agreement === 'inconsistent')
  const unrecorded = (producer.shadowUnrecorded ?? 0) > 0
  const producerCountsUnavailable = producer.enforced && !producer.countsAvailable
  for (const row of OUTBOUND_STATUS_EXIT_CODES) {
    if (row.name === 'expected-held-violated' && options.expectHeld && (report.anyGranted || anyLive)) return row.code
    if (row.name === 'unreadable-grant' && (report.anyUnreadable || producerUnreadable)) return row.code
    if (row.name === 'pre-cutoff-queued' && preCutoff) return row.code
    if (row.name === 'inconsistent' && inconsistent) return row.code
    if (row.name === 'shadow-unrecorded' && unrecorded) return row.code
    if (row.name === 'counts-unavailable' && (!report.countsAvailable || producerCountsUnavailable)) return row.code
  }
  return exitCode('ok')
}

export function renderOutboundStatusText(report: OutboundStatusReport): string {
  const lines: string[] = []
  const granted = report.connectors.filter((entry) => entry.state === 'granted')
  if (granted.length === 0) {
    lines.push('HELD: this installation may not write to WooCommerce, Mintsoft or Xero. Every write is refused before it leaves IMS.')
  } else {
    lines.push(
      `WRITES MAY LEAVE for: ${granted.map((entry) => `${entry.label} (${entry.destination})`).join('; ')}. `
      + 'A grant says a write may be sent; it does not show that any writer is enabled.',
    )
  }
  for (const entry of report.connectors) {
    const refusals = entry.refusalsInWindow === null ? 'refusal count unavailable' : `at least ${entry.refusalsInWindow} write(s) refused in the last ${report.windowHours}h`
    const last = entry.lastRefusalAt ? `, last at ${entry.lastRefusalAt}` : ''
    const stateText = entry.state === 'held'
      ? 'HELD (no grant)'
      : entry.state === 'granted'
        ? `GRANTED to ${entry.destination}`
        : `HELD, grant UNREADABLE (${entry.detail})`
    lines.push(`  ${entry.label.padEnd(12)} ${stateText} [${entry.envName}] - ${refusals}${last}`)
  }
  if (!report.countsAvailable) {
    lines.push('The activity log could not be read, so the refusal counts above are unavailable.')
  }
  lines.push(...renderProducerStatusLines(report))
  return lines.join('\n')
}

function renderProducerStatusLines(report: OutboundStatusReport): string[] {
  const producer = report.producer
  if (!producer.enforced) return []
  const lines: string[] = ['', 'Producer-side hold (what IMS decides about its own work):']
  if (!producer.enforcementReadable) lines.push('  The enforcement variable is set but unreadable, so EVERY destination is enforced. Fix the value.')
  for (const entry of producer.destinations) {
    if (!entry.enforced) {
      lines.push(`  ${entry.label.padEnd(12)} not enforced: IMS produces work for it exactly as before the hold existed.`)
      continue
    }
    lines.push(`  ${entry.label.padEnd(12)} ${entry.phase === 'P2' ? `LIVE PHASE from ${entry.liveFrom}` : 'HELD PHASE'} - ${entry.agreementText}`)
    lines.push(`    operations that would be LIVE if produced now: ${entry.liveOperations} of ${entry.operations.length}`)
    const counts = entry.counts
    if (!counts) {
      lines.push(`    counts unavailable (the database could not be read)`)
      continue
    }
    const reasons = Object.entries(counts.shadowsByReason).map(([reason, n]) => `${reason}: ${n}`).join(', ') || 'none'
    lines.push(`    shadows: ${counts.shadowsLastWindow} new in the last ${PRODUCER_STATUS_WINDOW_HOURS}h, ${counts.shadowsTotal} distinct and ${counts.shadowOccurrencesTotal} counting repeats in total (by reason: ${reasons})`)
    lines.push(`    queued: ${counts.queued.syncLog} accounting sync row(s), ${counts.queued.outbox} outbox job(s), ${counts.queued.links} warehouse order link(s)`)
    lines.push(`    sent in the last ${PRODUCER_STATUS_WINDOW_HOURS}h: ${counts.sentLastWindow.syncLog} sync row(s), ${counts.sentLastWindow.outbox} outbox job(s), ${counts.sentLastWindow.links} order link(s)`)
    const pre = derivePreCutoffTotal(counts)
    lines.push(entry.phase === 'P2'
      ? `    queued BEFORE the live-from instant: ${pre}${pre > 0 ? ' - IMS will not deliver these; retire them with npm run retire:held-backlog' : ''}`
      : '    queued before the live-from instant: not applicable until the destination is live')
  }
  if (producer.shadowUnrecorded !== null && producer.shadowUnrecorded > 0) {
    lines.push(`  WARNING: ${producer.shadowUnrecorded} shadow(s) could not be recorded in the last ${PRODUCER_STATUS_WINDOW_HOURS}h (outbound_shadow_unrecorded in the activity log).`)
  }
  if (!producer.countsAvailable) lines.push('  The shadow and queue counts could not be read.')
  return lines
}
