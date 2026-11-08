import { producerBeforeCutoffNotice, producerShadowNotice } from '@/lib/security/producer-disposition-constants'
import type { ProducerDecision } from '@/lib/security/producer-disposition'
import { createdBeforeCutoffFloor, producerCutoffFloor, producerSeamVerdict, readProducerEnforcement } from '@/lib/security/producer-seam'
import { AccountingSyncType } from '@/app/generated/prisma/client'
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

/**
 * WHERE EACH ACCOUNTING SYNC TYPE GETS ITS BUSINESS-EVENT TIME (`obligationAt`), DECLARED ONCE.
 *
 *   payload         read from the named payload field by {@link xeroObligationAt}; the producer is responsible for writing it.
 *   parent          a follow-up: it inherits the obligation of the row its payload names in `sourceEntryId`
 *                   ({@link xeroResolveObligationAt}). The follow-up payload carries no date of its own, and adding one would change
 *                   the hashed fields of the request it pins, so the date is read from the parent instead. A parent that is gone, or
 *                   whose payload was compacted to nothing, gives no obligation: the follow-up is SHADOW (fail closed).
 *   not-applicable  the ownership map marks the operation `obligationTime: 'not-applicable'`: no event time is asked for.
 *   excluded        not a destination write (ACCOUNTING_SYNC_TYPE_EXCLUSIONS).
 *   dead            declared in the enum, no producer exists; kept so removing it stays a deliberate migration.
 *
 * A Record over the enum, so a new AccountingSyncType does not compile until it is declared here;
 * tests/accounting/xero-obligation-sources.test.ts pins every entry against the ownership map and the real payload builders.
 */
export type XeroObligationSource =
  | { kind: 'payload'; field: (typeof OBLIGATION_DATE_FIELDS)[number] }
  | { kind: 'parent' }
  | { kind: 'not-applicable' }
  | { kind: 'excluded' }
  | { kind: 'dead' }

export const XERO_OBLIGATION_SOURCES: Readonly<Record<AccountingSyncType, XeroObligationSource>> = {
  PURCHASE_INVOICE: { kind: 'payload', field: 'date' },
  PURCHASE_INVOICE_UPDATE: { kind: 'payload', field: 'date' },
  COGS_JOURNAL: { kind: 'payload', field: 'date' },
  INVENTORY_ADJUSTMENT: { kind: 'payload', field: 'date' },
  SALES_INVOICE: { kind: 'payload', field: 'date' },
  SALES_INVOICE_UPDATE: { kind: 'payload', field: 'date' },
  INVOICE_PAYMENT: { kind: 'payload', field: 'paymentDate' },
  BILL_ATTACHMENT: { kind: 'parent' },
  INVOICE_PDF: { kind: 'excluded' },
  INVOICE_EMAIL: { kind: 'excluded' },
  WC_INVOICE_NOTE: { kind: 'parent' },
  CREDIT_NOTE: { kind: 'payload', field: 'date' },
  PURCHASE_CREDIT_NOTE: { kind: 'payload', field: 'date' },
  PURCHASE_CREDIT_NOTE_ALLOCATION: { kind: 'payload', field: 'date' },
  STOCK_IN_TRANSIT: { kind: 'payload', field: 'date' },
  STOCK_RECEIPT: { kind: 'payload', field: 'date' },
  COGS_REVERSAL: { kind: 'payload', field: 'date' },
  STOCK_ALLOCATION: { kind: 'dead' },
  DAILY_BATCH_REVENUE_DEFERRAL: { kind: 'payload', field: 'date' },
  DAILY_BATCH_INVENTORY_ALLOC: { kind: 'payload', field: 'date' },
  DAILY_BATCH_GROUP_B: { kind: 'payload', field: 'date' },
  DAILY_BATCH_INVENTORY_RECONCILIATION: { kind: 'payload', field: 'date' },
  DAILY_BATCH_COGS_RECONCILIATION: { kind: 'payload', field: 'date' },
  DAILY_BATCH_TRANSIT_RECONCILIATION: { kind: 'payload', field: 'date' },
  UNEARNED_REV_REVERSAL: { kind: 'payload', field: 'date' },
  ALLOCATION_REVERSAL: { kind: 'payload', field: 'date' },
  BILL_PAYMENT: { kind: 'payload', field: 'paymentDate' },
  REALISED_FX_JOURNAL: { kind: 'not-applicable' },
  UNREALISED_FX_JOURNAL: { kind: 'not-applicable' },
  MANUFACTURING_JOURNAL: { kind: 'payload', field: 'date' },
  MANUFACTURING_RECLASS: { kind: 'payload', field: 'date' },
  TAX_RATE_SYNC: { kind: 'not-applicable' },
}

/** The part of a Prisma client {@link xeroResolveObligationAt} needs. Optional on purpose: a client that cannot read the parent gives no obligation. */
export type ObligationParentReader = {
  accountingSyncLog?: {
    findUnique?: (args: { where: { id: string }; select: { payload: true } }) => Promise<{ payload: unknown } | null>
  }
}

/**
 * The business-event time of a queued posting: its own payload's date, or for a follow-up (source kind `parent`) the parent row's.
 * The parent is read only when the hold is enforced for the follow-up's destination, so with the switch off no query is made and the
 * result is never used. Undefined whenever the time cannot be read: the decision then shadows an operation that requires it.
 */
export async function xeroResolveObligationAt(
  client: ObligationParentReader,
  input: { type: string; payload: unknown; env?: Record<string, string | undefined> },
): Promise<Date | undefined> {
  const source = (XERO_OBLIGATION_SOURCES as Readonly<Record<string, XeroObligationSource>>)[input.type]
  if (source?.kind !== 'parent') return xeroObligationAt(input.payload)
  const target = destinationAndOperationForSyncType(input.type)
  const enforcement = readProducerEnforcement(input.env ?? process.env)
  if (!target || !enforcement.enforced || !enforcement.destinations.has(target.destination)) return undefined
  if (typeof input.payload !== 'object' || input.payload === null || Array.isArray(input.payload)) return undefined
  const parentId = (input.payload as Record<string, unknown>).sourceEntryId
  if (typeof parentId !== 'string' || parentId === '') return undefined
  const read = client.accountingSyncLog?.findUnique
  if (!read) return undefined
  const parent = await read.call(client.accountingSyncLog, { where: { id: parentId }, select: { payload: true } })
  return parent ? xeroObligationAt(parent.payload) : undefined
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
  /** The business-event time when it is not in the payload (a follow-up's parent: {@link xeroResolveObligationAt}). Wins over the payload. */
  obligationAt?: Date
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
    input.obligationAt ?? xeroObligationAt(input.payload),
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

/**
 * THE WRITER-SIDE CUT-OFF FOR ACCOUNTING ROWS: EACH ROW IS FLOORED BY THE LIVE-FROM INSTANT OF THE DESTINATION IT WRITES TO.
 *
 * Every queued row is an AccountingSyncLog row, but not every type writes to Xero: a WC_INVOICE_NOTE writes to WooCommerce
 * (ownership map `order.invoice-note`). WooCommerce and Xero go live at independent instants, so a note row is floored by the
 * WooCommerce one and every other write type by the Xero one. A type that is no destination write at all (a PDF fetch, an e-mail)
 * is floored by nothing. The sets are derived from the ownership map, not listed twice.
 */
export const WOO_SYNC_TYPES: readonly string[] = [...TYPE_INDEX].filter(([, entry]) => entry.destination === 'woocommerce').map(([type]) => type)
export const NOT_A_XERO_WRITE: readonly string[] = [...Object.keys(ACCOUNTING_SYNC_TYPE_EXCLUSIONS), ...WOO_SYNC_TYPES]
/**
 * Types the ownership map does not name (and that are no PDF fetch or e-mail). Nobody has said which destination they write to, so they are
 * floored by EVERY destination's cut-off: the stricter reading, never the laxer one.
 */
export const UNMAPPED_SYNC_TYPES: readonly string[] = Object.values(AccountingSyncType)
  .filter((type) => !TYPE_INDEX.has(type) && !Object.prototype.hasOwnProperty.call(ACCOUNTING_SYNC_TYPE_EXCLUSIONS, type))
/** The types the WooCommerce floor governs: its own and the unmapped ones. */
export const WOO_FLOORED_TYPES: readonly string[] = [...WOO_SYNC_TYPES, ...UNMAPPED_SYNC_TYPES]

/** Which destinations' floors judge a row of this type: its own, both for an unmapped or unknown type, none for a PDF fetch or an e-mail. */
export function floorDestinationsForType(type: string | undefined): OutboundConnector[] {
  if (type !== undefined && Object.prototype.hasOwnProperty.call(ACCOUNTING_SYNC_TYPE_EXCLUSIONS, type)) return []
  if (type === undefined) return ['xero', 'woocommerce']
  const target = TYPE_INDEX.get(type)
  if (!target) return ['xero', 'woocommerce']
  return [target.destination]
}

type FloorContext = { env?: Record<string, string | undefined>; now?: Date }

/**
 * THE WRITER-SIDE CUT-OFF FOR XERO: the instant before which a QUEUED accounting row is never delivered by IMS, or null when no such
 * floor applies (the producer hold is not enforced for Xero, or Xero is not in its live phase: legacy behaviour, byte for byte).
 * Every claim, every oldest-first selection and every re-queue of an accounting sync row asks here, and asks again at the moment of its
 * own write: it reads the environment each time and caches nothing. Rows that write to WooCommerce use {@link wooAccountingCutoffFloor}.
 */
export function xeroCutoffFloor(context?: FloorContext): Date | null {
  return producerCutoffFloor('xero', context ?? {})
}

/** The same cut-off for the accounting rows whose destination is WooCommerce (the invoice note), from the WooCommerce live-from instant. */
export function wooAccountingCutoffFloor(context?: FloorContext): Date | null {
  return producerCutoffFloor('woocommerce', context ?? {})
}

/** Whether ANY accounting-row floor is in force: the guard of the call sites that read a row's creation time only to compare it with a floor. */
export function accountingCutoffInForce(context?: FloorContext): boolean {
  return xeroCutoffFloor(context) !== null || wooAccountingCutoffFloor(context) !== null
}

/**
 * The operator sentence when a row may not be re-queued or delivered because it predates the cut-off, or null when it may (no floor,
 * created at or after it, or a type that is not a write to a destination at all: a PDF fetch and an e-mail are exactly as exempt as they are from
 * the producer decision). The floor is the one of the row's own destination. A row whose type is not given, or that the ownership map does not name,
 * is judged by every destination's floor: fail closed. The one place a re-queue path words this.
 */
export function xeroBeforeCutoffRefusal(
  row: { createdAt: Date | null | undefined; type?: string },
  context?: FloorContext,
): string | null {
  if (row.type !== undefined && Object.prototype.hasOwnProperty.call(ACCOUNTING_SYNC_TYPE_EXCLUSIONS, row.type)) return null
  for (const connector of floorDestinationsForType(row.type)) {
    if (connector !== 'xero' && connector !== 'woocommerce') continue
    const floor = connector === 'xero' ? xeroCutoffFloor(context) : wooAccountingCutoffFloor(context)
    if (floor !== null && createdBeforeCutoffFloor(row.createdAt, floor)) return producerBeforeCutoffNotice({ connector, cutoff: floor })
  }
  return null
}

/** The NOT clause for the rows created before their own destination's floor; none when neither floor is in force. */
function beforeFloorsClause(
  xeroFloor: Date | null,
  wooFloor: Date | null,
  extra: Record<string, unknown>,
): { NOT?: Record<string, unknown> } {
  const parts: Record<string, unknown>[] = []
  if (xeroFloor !== null) parts.push({ ...extra, createdAt: { lt: xeroFloor }, type: { notIn: NOT_A_XERO_WRITE } })
  if (wooFloor !== null) parts.push({ ...extra, createdAt: { lt: wooFloor }, type: { in: WOO_FLOORED_TYPES } })
  if (parts.length === 0) return {}
  return { NOT: parts.length === 1 ? parts[0] : { OR: parts } }
}

/**
 * The same rule as a where-fragment, for a claim or a selection: "NOT (created before its destination's floor AND a write type)". Empty with no
 * floor, so a query that spreads it is the legacy query exactly. The sync log's own statuses are untouched: a settled or cancelled row is not
 * delivered by any query that carries this, so it needs no exception here. `wooFloor` defaults to the WooCommerce floor of this moment.
 */
export function xeroNotBeforeCutoffWhere(floor: Date | null, wooFloor: Date | null = wooAccountingCutoffFloor()): { NOT?: Record<string, unknown> } {
  return beforeFloorsClause(floor, wooFloor, {})
}

/**
 * The same cut-off for a read that asks "is there earlier LIVE work for this key that I must wait behind?". A queued (PENDING) row created
 * before its floor can never be claimed, so waiting behind it is waiting for work that will not run: every later payment or update for the
 * document would be deferred for ever (a starvation behind a never-deliverable row). A PROCESSING row is NOT excluded: a claim taken before
 * the floor moved may still be in flight, and waiting behind an undetermined attempt is the money-safe answer. Empty with no floor, so a
 * query that spreads it is the legacy query exactly.
 */
export function xeroNotNeverDeliverablePendingWhere(floor: Date | null, wooFloor: Date | null = wooAccountingCutoffFloor()): { NOT?: Record<string, unknown> } {
  return beforeFloorsClause(floor, wooFloor, { status: 'PENDING' })
}
