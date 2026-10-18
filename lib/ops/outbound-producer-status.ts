import { OUTBOUND_CONNECTORS, OUTBOUND_CONNECTOR_LABEL, type OutboundConnector } from '@/lib/security/outbound-write-hold-constants'
import { explainProducerDisposition, producerGrantCutoffAgreement } from '@/lib/security/producer-disposition'
import { producerCutoffFloor, readProducerEnforcement } from '@/lib/security/producer-seam'
import { ACCOUNTING_SYNC_TYPE_EXCLUSIONS, WRITER_OWNERSHIP_MAP, type OwnershipRow } from '@/lib/security/writer-ownership-map'
import { PRODUCER_CUTOFF_ENV, type ProducerAgreementState } from '@/lib/security/producer-disposition-constants'

/**
 * THE PRODUCER-SIDE HALF OF `npm run outbound:status`: what each enforced destination decides, holds, has shadowed and has queued.
 *
 * The grant half (lib/ops/outbound-status.ts) says whether a write MAY leave. This half says what IMS is DOING about its own work:
 * per destination the grant and live-from instant and the phase they establish, what every mapped operation would decide if produced now,
 * how many shadows were kept (24 hours, total, by reason), what is queued, what was sent in the last 24 hours, and how much of the
 * queue predates the live-from instant (the writer refuses all of it, and it must be retired: see `npm run retire:held-backlog`).
 *
 * ONLY ENFORCED DESTINATIONS ARE EVALUATED. With PRODUCER_HOLD_ENFORCED_DESTINATIONS unset every destination reads `enforced: false`,
 * no count is read, no database is touched, and the report carries nothing that can change an exit code: the legacy behaviour exactly.
 *
 * Pure derivations here; the counts are read by an injected reader (the default one lives with the command) so every arm is testable
 * without a database.
 */

export type ProducerOperationDecision = {
  operation: string
  disposition: 'LIVE' | 'SHADOW'
  reason: string
  owner: string
}

export type ProducerQueueCounts = { outbox: number; syncLog: number; links: number }

export type ProducerDestinationCounts = {
  /** Shadow records: rows (distinct work) and occurrences (counting repeats), in the window and in total, by reason. */
  shadowsLastWindow: number
  shadowsTotal: number
  shadowOccurrencesTotal: number
  shadowsByReason: Record<string, number>
  queued: ProducerQueueCounts
  sentLastWindow: ProducerQueueCounts
  /** Queued work the writer-side cut-off refuses to deliver. Zero once the backlog is retired. */
  preCutoffQueued: ProducerQueueCounts
}

export type ProducerCountsRead = {
  byDestination: Partial<Record<OutboundConnector, ProducerDestinationCounts>>
  /** `outbound_shadow_unrecorded` entries in the window. */
  shadowUnrecorded: number
}

export type ProducerDestinationStatus = {
  connector: OutboundConnector
  label: string
  enforced: boolean
  /** Grant xor live-from instant, both readable, neither set, or unreadable. Null when not enforced. */
  agreement: ProducerAgreementState | null
  agreementText: string | null
  cutoffEnv: string
  /** The live-from instant when the destination is in its live phase; null otherwise. */
  liveFrom: string | null
  phase: 'P1' | 'P2' | null
  /** What each mapped operation decides if produced now. Empty when not enforced. */
  operations: ProducerOperationDecision[]
  liveOperations: number
  counts: ProducerDestinationCounts | null
}

export type OutboundProducerStatus = {
  enforced: boolean
  /** The enforcement variable is set to something unreadable (it then enforces every destination). */
  enforcementReadable: boolean
  destinations: ProducerDestinationStatus[]
  /** Null when not enforced, or when the counts could not be read. */
  shadowUnrecorded: number | null
  /** False when the counts were needed (some destination is enforced) and could not be read. */
  countsAvailable: boolean
}

const MAPPED = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]).filter((row) => row.destination !== 'customer-email')

/** What every operation of a destination decides if a unit of work were produced now (with a business-event time of now). */
export function operationDecisions(connector: OutboundConnector, env: Record<string, string | undefined>, now: Date): ProducerOperationDecision[] {
  return MAPPED.filter((row) => row.destination === connector).map((row) => {
    const decision = explainProducerDisposition(connector, row.operation as never, now, { env, now })
    return { operation: row.operation, disposition: decision.disposition, reason: decision.reason, owner: decision.owner }
  })
}

export function derivePreCutoffTotal(counts: ProducerDestinationCounts | null): number {
  return counts ? counts.preCutoffQueued.outbox + counts.preCutoffQueued.syncLog + counts.preCutoffQueued.links : 0
}

export async function buildProducerStatus(deps: {
  env: Record<string, string | undefined>
  now: Date
  readCounts: (input: { destinations: OutboundConnector[]; now: Date; env: Record<string, string | undefined> }) => Promise<ProducerCountsRead>
}): Promise<OutboundProducerStatus> {
  const enforcement = readProducerEnforcement(deps.env)
  const enforcedDestinations = enforcement.enforced ? OUTBOUND_CONNECTORS.filter((c) => enforcement.destinations.has(c)) : []

  let counts: ProducerCountsRead | null = null
  let countsAvailable = true
  if (enforcedDestinations.length > 0) {
    try {
      counts = await deps.readCounts({ destinations: [...enforcedDestinations], now: deps.now, env: deps.env })
    } catch {
      countsAvailable = false
    }
  }

  const destinations = OUTBOUND_CONNECTORS.map((connector): ProducerDestinationStatus => {
    const enforced = enforcedDestinations.includes(connector)
    const floor = enforced ? producerCutoffFloor(connector, { env: deps.env, now: deps.now }) : null
    const agreement = enforced ? producerGrantCutoffAgreement(connector, deps.env) : null
    const operations = enforced ? operationDecisions(connector, deps.env, deps.now) : []
    return {
      connector,
      label: OUTBOUND_CONNECTOR_LABEL[connector],
      enforced,
      agreement: agreement?.state ?? null,
      agreementText: agreement?.text ?? null,
      cutoffEnv: PRODUCER_CUTOFF_ENV[connector],
      liveFrom: floor ? floor.toISOString() : null,
      phase: enforced ? (floor ? 'P2' : 'P1') : null,
      operations,
      liveOperations: operations.filter((op) => op.disposition === 'LIVE').length,
      counts: counts?.byDestination[connector] ?? null,
    }
  })

  return {
    enforced: enforcedDestinations.length > 0,
    enforcementReadable: !enforcement.enforced || enforcement.readable,
    destinations,
    shadowUnrecorded: counts ? counts.shadowUnrecorded : null,
    countsAvailable,
  }
}

// ---------------------------------------------------------------------------------------------
// The default reader: the database. Imported lazily so the pure parts above load without it.
// ---------------------------------------------------------------------------------------------

export const PRODUCER_STATUS_WINDOW_HOURS = 24

export async function readProducerCountsFromDatabase(input: {
  destinations: OutboundConnector[]
  now: Date
  env: Record<string, string | undefined>
}): Promise<ProducerCountsRead> {
  const { db } = await import('@/lib/db')
  const { wmsConnectorIdsFor } = await import('@/lib/connectors/wms/producer-seam')
  const { INTEGRATION_OUTBOX_STATUS } = await import('@/lib/domain/integrations/outbox')
  const { outboxInternalOperationsOf } = await import('@/lib/domain/integrations/outbox-registry')
  const { OUTBOUND_SHADOW_UNRECORDED_ACTION } = await import('@/lib/domain/outbound-shadow/unrecorded')
  const since = new Date(input.now.getTime() - PRODUCER_STATUS_WINDOW_HOURS * 3_600_000)
  const byDestination: ProducerCountsRead['byDestination'] = {}

  const shadowRows = await db.$queryRaw<Array<{ destination: string; reason: string; rows: number; occurrences: number; recent: number }>>`
    SELECT destination, reason, COUNT(*)::int AS rows, COALESCE(SUM(occurrences), 0)::int AS occurrences,
           (COUNT(*) FILTER (WHERE last_produced_at >= ${since}))::int AS recent
    FROM outbound_shadow_writes GROUP BY destination, reason`

  for (const destination of input.destinations) {
    const floor = producerCutoffFloor(destination, { env: input.env, now: input.now })
    const internal = outboxInternalOperationsOf(destination)
    const ownOutbox = { connector: destination, ...(internal.length > 0 ? { operation: { notIn: internal } } : {}) }
    const queuedStatuses = [INTEGRATION_OUTBOX_STATUS.PENDING, INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED, INTEGRATION_OUTBOX_STATUS.PROCESSING]

    const mine = shadowRows.filter((row) => row.destination === destination)
    const shadowsByReason: Record<string, number> = {}
    for (const row of mine) shadowsByReason[row.reason] = (shadowsByReason[row.reason] ?? 0) + Number(row.rows)

    const queued: ProducerQueueCounts = { outbox: 0, syncLog: 0, links: 0 }
    const sent: ProducerQueueCounts = { outbox: 0, syncLog: 0, links: 0 }
    const pre: ProducerQueueCounts = { outbox: 0, syncLog: 0, links: 0 }

    queued.outbox = await db.integrationOutbox.count({ where: { ...ownOutbox, status: { in: queuedStatuses } } })
    sent.outbox = await db.integrationOutbox.count({ where: { ...ownOutbox, status: INTEGRATION_OUTBOX_STATUS.SUCCEEDED, updatedAt: { gte: since } } })
    if (floor) pre.outbox = await db.integrationOutbox.count({ where: { ...ownOutbox, status: { in: queuedStatuses }, createdAt: { lt: floor } } })

    if (destination === 'xero') {
      queued.syncLog = await db.accountingSyncLog.count({ where: { connector: 'xero', status: { in: ['PENDING', 'PROCESSING'] } } })
      sent.syncLog = await db.accountingSyncLog.count({ where: { connector: 'xero', status: 'SYNCED', syncedAt: { gte: since } } })
      // A PDF fetch and an e-mail are not writes to Xero: the cut-off does not govern them and the retirement leaves them, so they are not counted.
      if (floor) pre.syncLog = await db.accountingSyncLog.count({ where: { connector: 'xero', status: { in: ['PENDING', 'PROCESSING'] }, createdAt: { lt: floor }, type: { notIn: Object.keys(ACCOUNTING_SYNC_TYPE_EXCLUSIONS) as never } } })
    }
    const wmsConnectorIds = wmsConnectorIdsFor(destination)
    if (wmsConnectorIds.length > 0) {
      queued.links = await db.wmsOrderPushLink.count({ where: { connector: { in: wmsConnectorIds }, state: 'PENDING_CREATE' } })
      sent.links = await db.wmsOrderPushLink.count({ where: { connector: { in: wmsConnectorIds }, state: 'SYNCED', pushedAt: { gte: since } } })
      if (floor) {
        pre.links = await db.wmsOrderPushLink.count({
          where: { connector: { in: wmsConnectorIds }, state: 'PENDING_CREATE', order: { OR: [{ paidAt: null }, { paidAt: { lt: floor } }] } },
        })
      }
    }

    byDestination[destination] = {
      shadowsLastWindow: mine.reduce((sum, row) => sum + Number(row.recent), 0),
      shadowsTotal: mine.reduce((sum, row) => sum + Number(row.rows), 0),
      shadowOccurrencesTotal: mine.reduce((sum, row) => sum + Number(row.occurrences), 0),
      shadowsByReason,
      queued,
      sentLastWindow: sent,
      preCutoffQueued: pre,
    }
  }

  const shadowUnrecorded = await db.activityLog.count({ where: { action: OUTBOUND_SHADOW_UNRECORDED_ACTION, createdAt: { gte: since } } })
  return { byDestination, shadowUnrecorded }
}
