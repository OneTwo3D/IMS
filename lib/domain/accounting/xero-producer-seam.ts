import { producerShadowNotice } from '@/lib/security/producer-disposition-constants'
import type { ProducerDecision } from '@/lib/security/producer-disposition'
import { producerSeamVerdict, readProducerEnforcement } from '@/lib/security/producer-seam'
import type { OutboundConnector } from '@/lib/security/outbound-write-hold-constants'
import {
  ACCOUNTING_SYNC_TYPE_EXCLUSIONS,
  WRITER_OWNERSHIP_MAP,
  type MappedOperation,
  type OwnershipRow,
} from '@/lib/security/writer-ownership-map'

/**
 * THE XERO PRODUCER SEAM: WHAT `createAccountingSyncLogRow` ASKS BEFORE IT WRITES A QUEUED POSTING.
 *
 * Every queued Xero posting is an AccountingSyncLog row, and every row is created by that one primitive, so asking
 * here covers the facade enqueue, the in-transaction enqueue, the daily batches and the follow-ups at once. The
 * (destination, operation) of a row follows from its AccountingSyncType through the ownership map's own
 * `accountingSyncTypes`; this module holds no second table of types.
 *
 *   legacy   the producer hold is not enforced for the row's destination: the row is created exactly as before.
 *   live     enforced, and the decision is LIVE.
 *   shadow   enforced, and the decision is SHADOW: the caller records a shadow and queues nothing.
 *
 * Only connector 'xero' is asked. A type the ownership map excludes (a PDF fetch, an e-mail) is not a write to a
 * destination and is always legacy. An enforced destination with a type the map does not name is SHADOW: a posting
 * nobody has classified is not produced.
 */

type TypeIndexEntry = { destination: OutboundConnector; operation: string }

const TYPE_INDEX: ReadonlyMap<string, TypeIndexEntry> = (() => {
  const index = new Map<string, TypeIndexEntry>()
  for (const entry of WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]) {
    if (entry.destination === 'customer-email') continue
    for (const type of entry.accountingSyncTypes ?? []) index.set(type, { destination: entry.destination, operation: entry.operation })
  }
  return index
})()

/** The (destination, operation) an AccountingSyncType produces, or null when the map does not name it. */
export function destinationAndOperationForSyncType(type: string): TypeIndexEntry | null {
  return TYPE_INDEX.get(type) ?? null
}

/** Payload fields that carry the business-event date of a posting, in the order they are believed. */
const OBLIGATION_DATE_FIELDS = ['paymentDate', 'date', 'invoiceDate'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/

/**
 * The business-event time of a queued posting, from its payload: the payment date, else the document or journal date
 * (for a daily batch, the batch date). A date without a time is read as the start of that day in UTC, the earlier
 * reading, so a posting dated on the live-from day itself is the safe side of the line. Undefined when the payload
 * carries no readable date: the decision then treats an operation that requires the time as SHADOW.
 */
export function xeroObligationAt(payload: unknown): Date | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  for (const field of OBLIGATION_DATE_FIELDS) {
    const value = record[field]
    if (typeof value !== 'string' || !DATE_RE.test(value)) continue
    const at = new Date(value.includes('T') || value.includes(' ') ? value : `${value}T00:00:00Z`)
    if (!Number.isNaN(at.getTime())) return at
  }
  return undefined
}

export type XeroSeamVerdict =
  | { kind: 'legacy' }
  | { kind: 'live'; destination: OutboundConnector; operation: string; decision: ProducerDecision }
  | {
      kind: 'shadow'
      destination: OutboundConnector
      operation: string
      decision: ProducerDecision
      /** The single-sourced operator sentence for this shadow. */
      notice: string
    }

export function xeroProducerSeamVerdict(input: {
  connector: string
  type: string
  payload: unknown
  env?: Record<string, string | undefined>
  now?: Date
}): XeroSeamVerdict {
  if (input.connector !== 'xero') return { kind: 'legacy' }
  if (Object.prototype.hasOwnProperty.call(ACCOUNTING_SYNC_TYPE_EXCLUSIONS, input.type)) return { kind: 'legacy' }
  const context = { ...(input.env ? { env: input.env } : {}), ...(input.now ? { now: input.now } : {}) }
  const target = destinationAndOperationForSyncType(input.type)
  if (!target) {
    // A type the map does not name: nobody has said who writes it. Not produced while the hold is enforced.
    const enforcement = readProducerEnforcement(input.env ?? process.env)
    if (!enforcement.enforced || !enforcement.destinations.has('xero')) return { kind: 'legacy' }
    const decision: ProducerDecision = { disposition: 'SHADOW', reason: 'owner_unknown', owner: 'unknown', phase: 'P1', cutoff: null, grant: 'unreadable' }
    return { kind: 'shadow', destination: 'xero', operation: `unmapped:${input.type}`, decision, notice: producerShadowNotice({ connector: 'xero', reason: decision.reason, owner: decision.owner }) }
  }
  const verdict = producerSeamVerdict(
    target.destination,
    target.operation as MappedOperation<typeof target.destination>,
    xeroObligationAt(input.payload),
    context,
  )
  if (verdict.kind === 'legacy') return { kind: 'legacy' }
  if (verdict.kind === 'live') return { kind: 'live', destination: target.destination, operation: target.operation, decision: verdict.decision }
  return {
    kind: 'shadow',
    destination: target.destination,
    operation: target.operation,
    decision: verdict.decision,
    notice: producerShadowNotice({ connector: target.destination, reason: verdict.decision.reason, owner: verdict.decision.owner }),
  }
}
