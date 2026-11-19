'use server'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { revalidatePath } from 'next/cache'
import { freshAuthFailureResult, requireFreshPermission, requirePermission } from '@/lib/auth/server'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'
import { resolveAsnCancelRequest } from '@/lib/domain/wms/transfer-dispatch-cancel-asn'
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
  /** What the row is about (SALES_ORDER, WMS_ASN_MAP, ...). */
  entityType: string
  /** The copy-ready text to paste into a warehouse query, for a row that is one (an ASN cancel request). */
  queryText: string | null
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
    entityType: row.entityType,
    queryText: row.action === 'WMS_ASN_CANCEL_REQUEST' ? row.detail : null,
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

export type ConfirmAsnCancelRequestResult = { success: boolean; error?: string } | FreshAuthFailureResult

/**
 * Done on an "ask the warehouse to cancel the ASN" row: the operator raised the query in the warehouse's system. Needs the sync permission and a
 * fresh sign-in. Only that action can be closed here; every other refusal closes itself.
 */
export async function confirmAsnCancelRequestAction(refusedActionId: string): Promise<ConfirmAsnCancelRequestResult> {
  try {
    const session = await requireFreshPermission('sync')
    if (typeof refusedActionId !== 'string' || refusedActionId === '') return { success: false, error: 'No request was named.' }
    const row = await db.refusedAction.findUnique({ where: { id: refusedActionId }, select: { entityId: true, action: true, resolvedAt: true, intent: true } })
    if (!row || row.action !== 'WMS_ASN_CANCEL_REQUEST') return { success: false, error: 'That is not an open request to cancel an ASN.' }
    if (row.resolvedAt) return { success: false, error: 'That request was already marked done.' }
    if (await resolveAsnCancelRequest(db, row.entityId)) {
      const intent = row.intent && typeof row.intent === 'object' && !Array.isArray(row.intent) ? row.intent as { transferId?: unknown; externalAsnId?: unknown; orderNumber?: unknown } : {}
      // Who said the warehouse was asked: the row holds only the resolution, so the actor goes in the activity log.
      await logActivity({
        entityType: 'STOCK_TRANSFER',
        entityId: typeof intent.transferId === 'string' ? intent.transferId : row.entityId,
        action: 'asn_cancel_request_confirmed',
        tag: 'stock',
        userId: session.user.id,
        description: `Confirmed the warehouse was asked to cancel ASN ${typeof intent.externalAsnId === 'string' ? intent.externalAsnId : row.entityId} for transfer ${typeof intent.orderNumber === 'string' ? intent.orderNumber : ''}`.trim(),
        metadata: { asnMapId: row.entityId, refusedActionId },
      })
    }
    revalidatePath('/sync/exceptions')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}
