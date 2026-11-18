import { randomUUID } from 'node:crypto'
import type { Prisma } from '@/app/generated/prisma/client'

/**
 * REFUSED OR STALLED ACTIONS: ONE DURABLE RECORD OF "IMS WANTED THIS, A GATE SAID NO, AND NOTHING ELSE SAYS SO".
 *
 * Three defects shared one shape: an action was requested, a hard gate refused it, and the refusal left no record anywhere a person looks (a
 * string on a link, a `pending` result that read as "come back later", a log line nobody grepped). The refusing code always knew why. This module
 * is where it writes that down, once, so that:
 *
 *   - a refusal is a ROW (entity, action, gate), whose `permanence` says whether it can ever succeed: "not yet" and "never" stop looking alike;
 *   - the same refusal seen again is the SAME row: lastSeenAt moves, attempts counts, no duplicate is made (an upsert on the key, safe under concurrency);
 *   - the row has an AGE (firstSeenAt), and a refusal that stands past its severity's threshold becomes ONE alert (alertedAt makes it once per episode);
 *   - the SEVERITY comes from the INTENT (what was being changed), not from the bare fact of refusal: a line quantity or SKU change on an order being
 *     picked is serious, a note or a VAT number is noise. Escalating both equally teaches people to ignore the surface.
 *
 * The row holds NO personal data: the intent is the warehouse push summary (order number, SKUs, quantities, amounts) built by IMS, and the detail is
 * fixed wording built from a status token, never a remote error string.
 */

export const REFUSED_ACTION_PERMANENCE = ['PERMANENT', 'RETRYABLE'] as const
export type RefusedActionPermanence = (typeof REFUSED_ACTION_PERMANENCE)[number]

export const REFUSED_ACTION_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const
export type RefusedActionSeverity = (typeof REFUSED_ACTION_SEVERITIES)[number]

/** The actions and gates this record is written for. A new instance adds its pair here, so the surface can name it. */
export const REFUSED_ACTIONS = {
  /** An amendment attempted after the warehouse order left NEW. */
  WMS_ORDER_AMEND: { label: 'Order change not applied in the warehouse', gates: ['WMS_ORDER_NOT_NEW', 'WMS_AMEND_UNBUILDABLE'] },
  /** A split warehouse order that can never complete in IMS because a part was cancelled. */
  WMS_SPLIT_ORDER_COMPLETE: { label: 'Split order cannot complete', gates: ['WMS_SPLIT_PART_CANCELLED'] },
} as const
export type RefusedActionName = keyof typeof REFUSED_ACTIONS

/** What a refusal's entity is. */
export const REFUSED_ACTION_ENTITY_SALES_ORDER = 'SALES_ORDER'

/**
 * HOW LONG A REFUSAL MAY STAND BEFORE IT IS AN ALERT, per severity. `null` = never alerts (it stays on the exceptions page, and is not counted in the
 * banner): the noise tier. Named constants, not a setting: nothing else in IMS tunes an alert age from settings, and these are policy, not configuration.
 *
 *   HIGH    2 hours: a quantity or SKU change on an order the warehouse is already handling, and the warehouse is about to act on stale lines.
 *   MEDIUM  24 hours: a condition that stops an order completing in IMS, and one that changes how it ships.
 *   LOW     never: a VAT number, a note, a price: it changes nothing the warehouse does.
 */
export const REFUSED_ACTION_ALERT_AFTER_MS: Readonly<Record<RefusedActionSeverity, number | null>> = {
  HIGH: 2 * 60 * 60 * 1000,
  MEDIUM: 24 * 60 * 60 * 1000,
  LOW: null,
}

/** How many unresolved rows one escalation pass will alert on (oldest first); the rest wait for the next pass. */
export const REFUSED_ACTION_ESCALATION_BATCH = 100

// ---------------------------------------------------------------------------------------------------------------------------------------
// Severity from intent
// ---------------------------------------------------------------------------------------------------------------------------------------

type IntentLine = { sku: string; quantity: number }

/**
 * Did the amendment change what the warehouse has to PICK? `recorded` is the lines IMS last recorded on the warehouse order (null/empty = no usable
 * record). The comparison is by SKU, summed, so a re-ordering is not a change.
 *   CHANGED   a SKU or a quantity differs: the warehouse is working from stale lines.
 *   UNCHANGED the same lines: only money, courier or other header data moved.
 *   UNKNOWN   no usable record to compare against: a change to the lines cannot be ruled out.
 */
export type AmendmentLineChange = 'CHANGED' | 'UNCHANGED' | 'UNKNOWN'

function bySku(lines: ReadonlyArray<IntentLine>): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of lines) out.set(line.sku, (out.get(line.sku) ?? 0) + Number(line.quantity))
  return out
}

export function classifyAmendmentLineChange(intentLines: ReadonlyArray<IntentLine>, recorded: ReadonlyArray<IntentLine> | null | undefined): AmendmentLineChange {
  if (!recorded || recorded.length === 0) return 'UNKNOWN'
  const want = bySku(intentLines)
  const have = bySku(recorded)
  if (want.size !== have.size) return 'CHANGED'
  for (const [sku, quantity] of want) if (have.get(sku) !== quantity) return 'CHANGED'
  return 'UNCHANGED'
}

/**
 * The severity of an amendment the warehouse order could not take. Orders reach the amendment pass only while PROCESSING or ALLOCATED in IMS (not
 * despatched there), so the warehouse is either about to pick the order or already picking it: a change to the lines is HIGH. A change that cannot be
 * ruled out (no recorded lines) is HIGH as well: the safe side, and rare. Everything else (a VAT number, a note, a price, a discount) changes nothing
 * the warehouse does and is LOW.
 */
export function amendmentSeverity(lineChange: AmendmentLineChange): RefusedActionSeverity {
  return lineChange === 'UNCHANGED' ? 'LOW' : 'HIGH'
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The upsert, and resolution
// ---------------------------------------------------------------------------------------------------------------------------------------

export type RefusedActionInput = {
  entityType: string
  entityId: string
  action: RefusedActionName
  gate: string
  permanence: RefusedActionPermanence
  severity: RefusedActionSeverity
  /** PII-free: what IMS was trying to do. */
  intent?: Prisma.InputJsonValue | null
  /** One fixed-wording line. Never remote free text. */
  detail?: string | null
  now?: Date
}

export type RecordedRefusal = {
  id: string
  /** True when this call began an episode (a new row, or a resolved row refused again): the first sighting. */
  episodeStarted: boolean
  attempts: number
}

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw'>

/**
 * Record a refusal. IDEMPOTENT on (entityType, entityId, action, gate): INSERT ... ON CONFLICT DO UPDATE, so two overlapping writers make one row.
 *
 *   - A standing refusal seen again: lastSeenAt moves forward (never back), attempts counts, the intent and detail are the latest (the amendment is a
 *     full push, so the latest intent includes every earlier change), the severity is the latest, and firstSeenAt and alertedAt are kept.
 *   - A RESOLVED row refused again is a NEW episode on the same row: firstSeenAt restarts, attempts restarts, alertedAt clears, resolvedAt clears.
 */
export async function recordRefusedAction(client: RawClient, input: RefusedActionInput): Promise<RecordedRefusal> {
  const at = (input.now ?? new Date()).toISOString()
  const intent = input.intent === undefined || input.intent === null ? null : JSON.stringify(input.intent)
  const rows = await client.$queryRaw<Array<{ id: string; attempts: number }>>`
    INSERT INTO refused_actions (id, entity_type, entity_id, action, gate, permanence, severity, intent, detail, attempts, first_seen_at, last_seen_at)
    VALUES (${randomUUID()}, ${input.entityType}, ${input.entityId}, ${input.action}, ${input.gate},
            ${input.permanence}::"RefusedActionPermanence", ${input.severity}::"RefusedActionSeverity", ${intent}::jsonb, ${input.detail ?? null},
            1, ${at}::timestamptz AT TIME ZONE 'UTC', ${at}::timestamptz AT TIME ZONE 'UTC')
    ON CONFLICT (entity_type, entity_id, action, gate) DO UPDATE SET
      permanence = EXCLUDED.permanence,
      severity = EXCLUDED.severity,
      intent = EXCLUDED.intent,
      detail = EXCLUDED.detail,
      attempts = CASE WHEN refused_actions.resolved_at IS NULL THEN refused_actions.attempts + 1 ELSE 1 END,
      first_seen_at = CASE WHEN refused_actions.resolved_at IS NULL THEN refused_actions.first_seen_at ELSE EXCLUDED.first_seen_at END,
      last_seen_at = GREATEST(refused_actions.last_seen_at, EXCLUDED.last_seen_at),
      alerted_at = CASE WHEN refused_actions.resolved_at IS NULL THEN refused_actions.alerted_at ELSE NULL END,
      resolution = NULL,
      resolved_at = NULL
    RETURNING id, attempts
  `
  const row = rows[0]!
  return { id: row.id, attempts: row.attempts, episodeStarted: row.attempts === 1 }
}

/** Why a row was closed. */
export type RefusedActionResolution = 'ACTION_SUCCEEDED' | 'NO_LONGER_NEEDED'

/** Close every open refusal of this entity (and, when named, this action). Returns how many rows were closed. Safe to call when there is none. */
export async function resolveRefusedActions(
  client: Pick<Prisma.TransactionClient, 'refusedAction'>,
  where: { entityType: string; entityId: string; action?: RefusedActionName },
  resolution: RefusedActionResolution,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await client.refusedAction.updateMany({
    where: { entityType: where.entityType, entityId: where.entityId, resolvedAt: null, ...(where.action ? { action: where.action } : {}) },
    data: { resolvedAt: now, resolution },
  })
  return count
}

/**
 * Close the open sales-order refusals whose order no longer needs the action: it was cancelled, fully refunded, despatched or completed, or deleted.
 * One statement, so it is cheap to run every pass. (A refusal against an order still in flight stays open until it succeeds or the order ends.)
 */
export async function resolveObsoleteRefusedActions(client: RawClient, now: Date = new Date()): Promise<number> {
  const at = now.toISOString()
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    UPDATE refused_actions r
       SET resolved_at = ${at}::timestamptz AT TIME ZONE 'UTC', resolution = 'NO_LONGER_NEEDED'
     WHERE r.resolved_at IS NULL
       AND r.entity_type = ${REFUSED_ACTION_ENTITY_SALES_ORDER}
       AND NOT EXISTS (
         SELECT 1 FROM sales_orders o
          WHERE o.id = r.entity_id
            AND o.status::text NOT IN ('CANCELLED', 'SHIPPED', 'COMPLETED', 'DELIVERED')
            AND o."refundStatus"::text <> 'FULL'
       )
    RETURNING r.id
  `
  return rows.length
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Age-based escalation
// ---------------------------------------------------------------------------------------------------------------------------------------

export type EscalationRow = {
  id: string
  entityType: string
  entityId: string
  action: string
  gate: string
  severity: RefusedActionSeverity
  permanence: RefusedActionPermanence
  intent: Prisma.JsonValue | null
  detail: string | null
  attempts: number
  firstSeenAt: Date
}

/** The IMS order number kept in the intent, for display; the entity id otherwise. */
export function refusedActionSubject(row: Pick<EscalationRow, 'entityId' | 'intent'>): string {
  const intent = row.intent
  if (intent && typeof intent === 'object' && !Array.isArray(intent) && typeof intent.orderNumber === 'string' && intent.orderNumber !== '') return intent.orderNumber
  return row.entityId
}

export function refusedActionLabel(action: string): string {
  return (REFUSED_ACTIONS as Record<string, { label: string }>)[action]?.label ?? action
}

/** The alert text. Fixed wording: what, which order, how long, whether it can ever succeed. No remote text, no personal data. */
export function describeRefusedActionAlert(row: EscalationRow, now: Date): { title: string; message: string } {
  const days = Math.max(0, Math.floor((now.getTime() - row.firstSeenAt.getTime()) / 86_400_000))
  const hours = Math.max(0, Math.floor((now.getTime() - row.firstSeenAt.getTime()) / 3_600_000))
  const age = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`
  const standing = row.permanence === 'PERMANENT' ? 'It will not succeed on its own.' : 'IMS is still retrying it.'
  return {
    title: `${refusedActionLabel(row.action)}`,
    message: `${refusedActionLabel(row.action)} for order ${refusedActionSubject(row)}: refused ${row.attempts} time${row.attempts === 1 ? '' : 's'} over ${age}. ${standing}${row.detail ? ` ${row.detail}` : ''} Open Sync > Exceptions to see what IMS was trying to do.`,
  }
}

export type EscalationClient = Pick<Prisma.TransactionClient, 'refusedAction'> & { $transaction<T>(fn: (tx: Pick<Prisma.TransactionClient, 'refusedAction' | 'user' | 'notification'>) => Promise<T>): Promise<T> }

export type EscalationResult = { alerts: number; deliveryFailures: number; aborted?: boolean }

/**
 * Alert on every refusal that has stood past its severity's threshold and has not been alerted yet. ONCE per record: the claim (alertedAt) and the
 * notification are written in ONE transaction, with a compare-and-set on the row still being open and unalerted, so two overlapping runs alert once
 * and a crash cannot leave a stamp with no alert. `notifyAdmins` is injected (the watchdog's `notifyActiveAdmins`: it throws when nobody can receive
 * it, which rolls the claim back so the next run tries again). A rolled-back claim counts as a delivery failure.
 */
export async function escalateAgedRefusedActions(
  client: EscalationClient,
  notifyAdmins: (tx: Pick<Prisma.TransactionClient, 'user' | 'notification'>, title: string, message: string, actionUrl: string) => Promise<void>,
  now: Date = new Date(),
  isNoRecipients: (error: unknown) => boolean = () => false,
): Promise<EscalationResult> {
  const due = REFUSED_ACTION_SEVERITIES.flatMap((severity) => {
    const after = REFUSED_ACTION_ALERT_AFTER_MS[severity]
    return after === null ? [] : [{ severity, firstSeenAt: { lte: new Date(now.getTime() - after) } }]
  })
  if (due.length === 0) return { alerts: 0, deliveryFailures: 0 }
  const rows = await client.refusedAction.findMany({
    where: { resolvedAt: null, alertedAt: null, OR: due },
    orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
    take: REFUSED_ACTION_ESCALATION_BATCH,
    select: { id: true, entityType: true, entityId: true, action: true, gate: true, severity: true, permanence: true, intent: true, detail: true, attempts: true, firstSeenAt: true },
  })
  let alerts = 0
  let deliveryFailures = 0
  for (const row of rows) {
    const { title, message } = describeRefusedActionAlert(row, now)
    try {
      const claimed = await client.$transaction(async (tx) => {
        const stamped = await tx.refusedAction.updateMany({ where: { id: row.id, resolvedAt: null, alertedAt: null }, data: { alertedAt: now } })
        if (stamped.count === 0) return false
        await notifyAdmins(tx, title, message, '/sync/exceptions')
        return true
      })
      if (claimed) alerts += 1
    } catch (error) {
      deliveryFailures += 1
      console.error(`[refused-actions] alert delivery failed for ${row.id}:`, error)
      if (isNoRecipients(error)) return { alerts, deliveryFailures, aborted: true }
    }
  }
  return { alerts, deliveryFailures }
}
