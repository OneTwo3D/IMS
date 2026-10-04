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
} = {}): Promise<OutboundStatusReport> {
  const now = deps.now ?? new Date()
  const states = readOutboundGrantStates(deps.env ?? process.env)

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
  }
}

function exitCode(name: string): number {
  const found = OUTBOUND_STATUS_EXIT_CODES.find((row) => row.name === name)
  if (!found) throw new Error(`outbound status exit code ${name} is not in the table`)
  return found.code
}

/** The exit code, by the precedence of OUTBOUND_STATUS_EXIT_CODES (array order). */
export function outboundStatusExitCode(report: OutboundStatusReport, options: { expectHeld?: boolean } = {}): number {
  for (const row of OUTBOUND_STATUS_EXIT_CODES) {
    if (row.name === 'expected-held-violated' && options.expectHeld && report.anyGranted) return row.code
    if (row.name === 'unreadable-grant' && report.anyUnreadable) return row.code
    if (row.name === 'counts-unavailable' && !report.countsAvailable) return row.code
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
    const refusals = entry.refusalsInWindow === null ? 'refusal count unavailable' : `${entry.refusalsInWindow} write(s) refused in the last ${report.windowHours}h`
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
  return lines.join('\n')
}
