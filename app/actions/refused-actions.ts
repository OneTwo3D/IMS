'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { refusedActionLabel, refusedActionSubject, type RefusedActionPermanence, type RefusedActionSeverity } from '@/lib/domain/refused-actions'

/**
 * SYNC > EXCEPTIONS: ACTIONS A GATE REFUSED OR STALLED.
 *
 * Read-only. Each row is one standing refusal (lib/domain/refused-actions.ts): what IMS was asked to do, which gate said no, whether it can ever
 * succeed, how long it has stood, and the intent (order and warehouse numbers, SKUs, quantities: no personal data). Rows close themselves when the
 * action later succeeds or the order no longer needs it; the highest-severity rows come first.
 */

const REFUSED_ACTION_PAGE_SIZE = 100

export type RefusedActionRow = {
  id: string
  orderId: string | null
  subject: string
  label: string
  gate: string
  severity: RefusedActionSeverity
  permanence: RefusedActionPermanence
  detail: string | null
  /** The lines IMS wanted the warehouse order to hold, when the intent names them. */
  wantedLines: string | null
  attempts: number
  firstSeenAt: string
  lastSeenAt: string
  alerted: boolean
}
export type RefusedActionPage = { rows: RefusedActionRow[]; total: number; shown: number }

function wantedLinesOf(intent: unknown): string | null {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return null
  const lines = (intent as { lines?: unknown }).lines
  if (!Array.isArray(lines) || lines.length === 0) return null
  const parts = lines.flatMap((line) => (line && typeof line === 'object' && typeof (line as { sku?: unknown }).sku === 'string' ? [`${Number((line as { quantity?: unknown }).quantity)} x ${(line as { sku: string }).sku}`] : []))
  return parts.length > 0 ? parts.join(', ') : null
}

/** Open (unresolved) refusals, most serious first, then oldest first. */
export async function listRefusedActions(): Promise<RefusedActionPage> {
  await requirePermission('sync')
  const where = { resolvedAt: null }
  const [total, found] = await Promise.all([
    db.refusedAction.count({ where }),
    db.refusedAction.findMany({ where, orderBy: [{ severity: 'desc' }, { firstSeenAt: 'asc' }, { id: 'asc' }], take: REFUSED_ACTION_PAGE_SIZE }),
  ])
  const rows = found.map((row): RefusedActionRow => ({
    id: row.id,
    orderId: row.entityType === 'SALES_ORDER' ? row.entityId : null,
    subject: refusedActionSubject(row),
    label: refusedActionLabel(row.action),
    gate: row.gate,
    severity: row.severity,
    permanence: row.permanence,
    detail: row.detail,
    wantedLines: wantedLinesOf(row.intent),
    attempts: row.attempts,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    alerted: row.alertedAt !== null,
  }))
  return { rows, total, shown: rows.length }
}
