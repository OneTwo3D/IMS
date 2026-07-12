import { db } from '@/lib/db'
import { redactActivityLogText } from '@/lib/activity-log'

/**
 * q66in.4.6: audit-grade timeline of connector mutations. Every IMS↔WMS state
 * change records ONE WmsMutationEvent row carrying operational before/after
 * images, so an operator can answer "what did the sync change, and what did
 * it look like before" without archaeology across ActivityLog/WmsSyncLog.
 *
 * Contract:
 *  - Best-effort: recording NEVER throws — an audit-row failure must not fail
 *    the mutation it describes (mirrors lib/activity-log.ts). Failures land on
 *    console.error only.
 *  - Payloads are built at the call sites from operational fields (states,
 *    ids, SKUs, quantities, totals) — never whole order/customer objects. The
 *    scrub below drops well-known PII keys as defense-in-depth, so a payload
 *    mistake degrades to a masked field instead of a leak.
 *  - Unlike logActivity this sink is NOT time-sliced by level: retention is a
 *    single window purged by the activity-cleanup cron (see
 *    purgeExpiredWmsMutationEvents).
 */

export type WmsMutationEventInput = {
  connector: string
  direction: 'OUTBOUND' | 'INBOUND'
  action: string
  outcome: 'SUCCEEDED' | 'FAILED'
  entityType: string
  entityId?: string | null
  externalId?: string | null
  summary: string
  before?: unknown
  after?: unknown
  error?: string | null
  jobId?: string | null
  triggeredBy?: string | null
}

/** Keys whose VALUES are dropped from audit payloads (case-insensitive substring match). */
const PII_KEY_PATTERN = /(email|phone|address|street|town|city|county|postcode|postal|zip|country|customername|firstname|lastname|fullname|company|vat|password|token|secret|apikey|authorization)/i

const MAX_PAYLOAD_DEPTH = 6
const MAX_ARRAY_LENGTH = 200
const MAX_STRING_LENGTH = 2000

/**
 * Recursively drop PII-keyed values, redact PII-shaped content INSIDE free
 * text (emails, tokens — Codex r1: a Mintsoft return reason or error message
 * can carry a customer email under an innocent key), and clamp size so a
 * payload mistake can't leak or bloat.
 */
export function scrubWmsMutationPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (depth >= MAX_PAYLOAD_DEPTH) return '[truncated]'
  if (typeof value === 'string') {
    const redacted = redactActivityLogText(value)
    return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}…` : redacted
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    const clamped = value.slice(0, MAX_ARRAY_LENGTH).map((item) => scrubWmsMutationPayload(item, depth + 1))
    if (value.length > MAX_ARRAY_LENGTH) clamped.push(`[+${value.length - MAX_ARRAY_LENGTH} more]`)
    return clamped
  }
  if (typeof value === 'object') {
    // Decimal.js / Prisma Decimal and friends stringify meaningfully.
    const proto = Object.getPrototypeOf(value)
    if (proto && proto !== Object.prototype) {
      const text = String(value)
      return text === '[object Object]' ? '[unserializable]' : scrubWmsMutationPayload(text, depth + 1)
    }
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = PII_KEY_PATTERN.test(key) ? '[masked]' : scrubWmsMutationPayload(entry, depth + 1)
    }
    return out
  }
  return String(value)
}

function toJson(value: unknown): object | undefined {
  if (value === undefined || value === null) return undefined
  const scrubbed = scrubWmsMutationPayload(value)
  try {
    return JSON.parse(JSON.stringify(scrubbed))
  } catch {
    return { error: 'unserializable payload' }
  }
}

function toRow(input: WmsMutationEventInput) {
  return {
    connector: input.connector,
    direction: input.direction,
    action: input.action,
    outcome: input.outcome,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    externalId: input.externalId ?? null,
    // summary/error are free text and take the same content redaction as
    // payload strings (Codex r1: raw exception messages bypassed the scrub).
    summary: redactActivityLogText(input.summary).slice(0, 500),
    before: toJson(input.before),
    after: toJson(input.after),
    error: input.error ? redactActivityLogText(input.error).slice(0, 1000) : null,
    jobId: input.jobId ?? null,
    triggeredBy: input.triggeredBy ?? null,
  }
}

export async function recordWmsMutationEvent(input: WmsMutationEventInput): Promise<void> {
  try {
    await db.wmsMutationEvent.create({ data: toRow(input) })
  } catch (error) {
    console.error(`[wms-mutation-audit] failed to record ${input.action} event:`, error)
  }
}

/**
 * Batch variant for high-volume loops (Codex r1: a returns backlog must not
 * pay one serial audit round trip per record). Same best-effort contract.
 */
export async function recordWmsMutationEvents(inputs: WmsMutationEventInput[]): Promise<void> {
  if (inputs.length === 0) return
  try {
    await db.wmsMutationEvent.createMany({ data: inputs.map(toRow) })
  } catch (error) {
    console.error(`[wms-mutation-audit] failed to record ${inputs.length} events:`, error)
  }
}

/**
 * Every action name the instrumented call sites emit — the timeline UI's
 * filter dropdown reads this static list instead of a groupBy over the whole
 * table on every request (Codex r1). Keep in sync when instrumenting a new
 * mutation.
 */
export const WMS_MUTATION_ACTIONS = [
  'align_down',
  'align_up',
  'asn_create',
  'booked_in_receipt',
  'bundle_create',
  'dispatch_applied',
  'order_cancel',
  'order_comment',
  'order_create',
  'order_hold',
  'order_release',
  'order_update',
  'product_upsert',
  'return_inbox',
] as const

/** Retention window for the mutation timeline (days). Audit-grade: a full year. */
export const WMS_MUTATION_EVENT_RETENTION_DAYS = 365

/** Purge timeline rows past retention — called by the activity-cleanup cron. */
export async function purgeExpiredWmsMutationEvents(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - WMS_MUTATION_EVENT_RETENTION_DAYS * 86_400_000)
  const result = await db.wmsMutationEvent.deleteMany({ where: { createdAt: { lt: cutoff } } })
  return result.count
}
