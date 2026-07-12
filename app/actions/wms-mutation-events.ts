'use server'

import { requirePermission } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { WMS_MUTATION_ACTIONS } from '@/lib/domain/wms/mutation-audit'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'

/**
 * q66in.4.6: read model for the WMS mutation-audit timeline — a chronological
 * feed of every connector mutation with its before/after images. Read-only;
 * rows are written by the sweeps/webhooks via recordWmsMutationEvent and
 * purged by the activity-cleanup cron after retention.
 */

const PAGE_SIZE = 50

export type WmsMutationEventRow = {
  id: string
  connector: string
  direction: 'OUTBOUND' | 'INBOUND'
  action: string
  outcome: 'SUCCEEDED' | 'FAILED'
  entityType: string
  entityId: string | null
  externalId: string | null
  summary: string
  before: unknown
  after: unknown
  error: string | null
  jobId: string | null
  triggeredBy: string | null
  createdAt: string
}

export type WmsMutationEventFilters = {
  connector?: string
  direction?: 'OUTBOUND' | 'INBOUND'
  action?: string
  outcome?: 'SUCCEEDED' | 'FAILED'
  /** Matches entityId OR externalId exactly (ids, order numbers, ASN ids). */
  entity?: string
}

export type WmsMutationEventPage = {
  rows: WmsMutationEventRow[]
  /** Cursor (id) for the next page; null when exhausted. */
  nextCursor: string | null
  /** Distinct action names present (for the filter dropdown). */
  actions: string[]
  connectors: string[]
}

export async function getWmsMutationEvents(
  filters: WmsMutationEventFilters = {},
  cursor: string | null = null,
): Promise<WmsMutationEventPage> {
  await requirePermission('sync')

  const entity = filters.entity?.trim()
  const where = {
    ...(filters.connector ? { connector: filters.connector } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.outcome ? { outcome: filters.outcome } : {}),
    ...(entity ? { OR: [{ entityId: entity }, { externalId: entity }] } : {}),
  }

  const rows = await db.wmsMutationEvent.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })

  const hasMore = rows.length > PAGE_SIZE
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows

  return {
    rows: page.map((row) => ({
      id: row.id,
      connector: row.connector,
      direction: row.direction,
      action: row.action,
      outcome: row.outcome,
      entityType: row.entityType,
      entityId: row.entityId,
      externalId: row.externalId,
      summary: row.summary,
      before: row.before ?? null,
      after: row.after ?? null,
      error: row.error,
      jobId: row.jobId,
      triggeredBy: row.triggeredBy,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
    // Static lists (Codex r1): a groupBy over the full audit table on every
    // filter change scales with table size for no benefit.
    actions: [...WMS_MUTATION_ACTIONS],
    connectors: [...WMS_CONNECTOR_IDS],
  }
}
