import { db } from '@/lib/db'
import { toJsonInputValue } from '@/lib/db/json-input'
// decimal-boundary-ok: report-only (accounting reconciliation finding details)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'
import {
  accountingDocumentRevisionFamily,
  ASSUMED_REVISION_ORDER_TAKEOVER_ACTION,
  isDocumentRevisionAccountingSyncType,
  isMirrorableAccountingSyncType,
} from './accounting-event-mirror'

export type AccountingReconciliationSeverity = 'warning' | 'critical'
export type AccountingReconciliationRunStatus = 'COMPLETED' | 'FAILED' | 'PARTIAL'
export type AccountingReconciliationFindingStatus = 'OPEN' | 'RESOLVED' | 'ACCEPTED'

export type AccountingReconciliationFinding = {
  severity: AccountingReconciliationSeverity
  code: string
  orderId?: string
  shipmentId?: string
  refundId?: string
  syncLogId?: string
  accountingEventId?: string
  message: string
  details: unknown
}

export type AccountingReconciliationReport = {
  runId?: string
  checkedAt: string
  fromDate: string
  toDate: string
  persisted?: boolean
  findings: AccountingReconciliationFinding[]
  summary: {
    total: number
    warning: number
    critical: number
  }
}

type SourceOrderRow = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  status: string
  refundStatus: string
  revenueDeferredDate: Date | string | null
  inventoryAllocatedDate: Date | string | null
  // o3d-0qoo: the exact A1/A2 batch referenceIds stamped on the row in the same
  // transaction as the stage stamps. Optional so pure-evaluator fixtures compile;
  // the Prisma select always provides them. Null/absent = pre-migration row, which
  // has nothing but the stamp and so falls back to the derived key.
  revenueDeferredBatchRef?: string | null
  inventoryAllocatedBatchRef?: string | null
}

type SourceShipmentRow = {
  id: string
  orderId: string
  shipmentJournalDate: Date | string | null
  // o3d-0qoo: the exact Group-B batch referenceId (pairs with shipmentJournalDate).
  shipmentJournalBatchRef?: string | null
}

type SourceRefundRow = {
  id: string
  orderId: string
  creditNoteNumber: string | null
  accountingCreditNoteId: string | null
  totalBase: DecimalLike
  accountingRetrySyncs: unknown
  // scjz.70: revenue-only chargeback — credit note only, no COGS/unearned reversal.
  // Optional: the Prisma select always provides it; absent is a normal refund.
  chargeback?: boolean
  // scjz.71: durable — whether a COGS/unearned reversal was staged for this refund.
  reversalStaged?: boolean
}

type AccountingSyncLogRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  payload: unknown
}

type AccountingEventRow = {
  id: string
  type: string
  sourceEntityType: string
  sourceEntityId: string
  businessDate: Date | string
  status: string
  idempotencyKey: string
  externalSystem: string | null
  externalId: string | null
}

/**
 * o3d-cvj9 r7 (Codex r7, HIGH): an audit entry recording that a document's external identifier moved
 * between event rows on an order NOTHING ESTABLISHED — the live mirror's assumed takeover.
 *
 * The mirror has to answer such a pair one way or the other (see the `acceptAssumedOrder` block in
 * `updateMirroredAccountingEventStatus` for why declining is the opposite guess rather than no
 * guess), and it answers in the direction that converges. What it must not do is answer silently:
 * the claim it moved is the money's document identity, and until this dataset existed nothing in the
 * product listed the documents it had moved. That is the whole reason this is read here.
 */
type RevisionClaimLogRow = {
  id: string
  accountingEventId: string
  action: string
  metadata: unknown
  createdAt: Date | string
}

export type AccountingReconciliationRows = {
  salesOrders: SourceOrderRow[]
  shipments: SourceShipmentRow[]
  refunds: SourceRefundRow[]
  syncLogs: AccountingSyncLogRow[]
  accountingEvents: AccountingEventRow[]
  /**
   * Optional so the pure-evaluator fixtures that predate it still compile and still mean what they
   * meant; `collectAccountingReconciliationRows` always provides it. Absent is NOT the same as empty
   * for the row-cap check below, which is why that check skips it rather than reading `?.length ?? 0`
   * — a dataset that was never read has not "returned zero rows".
   */
  revisionClaimLogs?: RevisionClaimLogRow[]
}

type AccountingReconciliationClient = {
  salesOrder: {
    findMany(args: unknown): Promise<SourceOrderRow[]>
  }
  shipment: {
    findMany(args: unknown): Promise<SourceShipmentRow[]>
  }
  salesOrderRefund: {
    findMany(args: unknown): Promise<SourceRefundRow[]>
  }
  accountingSyncLog: {
    findMany(args: unknown): Promise<AccountingSyncLogRow[]>
  }
  accountingEvent: {
    findMany(args: unknown): Promise<AccountingEventRow[]>
  }
  accountingEventLog: {
    findMany(args: unknown): Promise<RevisionClaimLogRow[]>
  }
}

type PersistedAccountingReconciliationFinding = {
  id: string
  runId: string
  severity: string
  code: string
  entityType: string | null
  entityId: string | null
  message: string
  details: unknown
  status: string
  statusUpdatedAt: Date | string | null
  statusUpdatedBy: string | null
  createdAt: Date | string
}

type PersistedAccountingReconciliationRun = {
  id: string
  fromDate: Date | string | null
  toDate: Date | string | null
  status: string
  totalCount: number
  warningCount: number
  criticalCount: number
  createdAt: Date | string
  findings?: PersistedAccountingReconciliationFinding[]
  _count?: { findings: number }
}

type AccountingReconciliationPersistenceClient = {
  $transaction?<T>(fn: (tx: AccountingReconciliationPersistenceClient) => Promise<T>): Promise<T>
  accountingReconciliationRun: {
    create(args: unknown): Promise<PersistedAccountingReconciliationRun>
    findMany(args: unknown): Promise<PersistedAccountingReconciliationRun[]>
  }
  accountingReconciliationFinding: {
    createMany(args: unknown): Promise<{ count: number }>
    findUnique(args: unknown): Promise<PersistedAccountingReconciliationFinding | null>
    update(args: unknown): Promise<PersistedAccountingReconciliationFinding>
  }
}

export const ACCOUNTING_RECONCILIATION_FINDING_STATUSES = ['OPEN', 'RESOLVED', 'ACCEPTED'] as const
export const MAX_RECONCILIATION_LIST_RUNS = 100
export const MAX_RECONCILIATION_FINDINGS_PER_RUN = 500

export const DEFAULT_RECONCILIATION_LOOKBACK_DAYS = 90
const MAX_RECONCILIATION_ROWS = 10_000
// Refunded orders are picked up by the refundStatus OR-branch in the source query;
// this set is now purely terminal lifecycle statuses.
const TERMINAL_SALES_ORDER_STATUSES = ['CANCELLED', 'COMPLETED', 'DELIVERED'] as const
// PENDING/PROCESSING are intentional evidence: reconciliation distinguishes
// "queued but not mirrored" from "no accounting path was ever scheduled".
const LIVE_SYNC_STATUSES = new Set(['PENDING', 'PROCESSING', 'SYNCED'])

// Document sync events are mirrorable, but their source checks are document-specific rather than DailyBatch source-key checks.
const SOURCE_TRACKED_EVENT_TYPES = new Set([
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
  'COGS_REVERSAL',
  'UNEARNED_REV_REVERSAL',
])

const REFUND_REVERSAL_TYPES = new Set([
  'COGS_REVERSAL',
  'UNEARNED_REV_REVERSAL',
])

// The three SOURCE_TRACKED types whose sourceEntityId is a daily-batch reference, i.e. the only ones
// a digest can ever be on. COGS_REVERSAL / UNEARNED_REV_REVERSAL are keyed on a refund or shipment id
// and must never be bridged.
const DAILY_BATCH_EVENT_TYPES = new Set([
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
])

// Live Xero daily-batch logs carry a digest-suffixed referenceId
// (buildDailyBatchReferenceId -> `<group>-<date>-<8 hex>`), and accounting-event-mirror copies that
// string verbatim into AccountingEvent.sourceEntityId. QuickBooks writes the bare `<group>-<date>`.
// Same rule, same regex, same reason as invariants.ts stripDailyBatchDigest (scjz.37).
function stripDailyBatchDigest(sourceEntityId: string): string {
  return sourceEntityId.replace(/-[0-9a-f]{8}$/, '')
}

function dateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

/**
 * The DailyBatch sourceEntityId to reconcile a staged row against, in BOTH
 * directions (forward: does an event exist for this source? reverse: does this
 * event have a source?). Both must use this one key or a single journal can
 * produce a `source_*_without_event` and an `event_without_source` at once.
 *
 * o3d-0qoo: prefer the referenceId persisted on the row. AccountingEvent.sourceEntityId
 * is copied verbatim from AccountingSyncLog.referenceId by accounting-event-mirror,
 * so the persisted ref is exactly the string the mirrored event carries. That fixes
 * two distinct mismatches at once:
 *  - the midnight crossing (batch date captured once at run start, stage stamps written
 *    with later new Date() calls, so the derived date can be the following day);
 *  - Xero's digest suffix — this module has no digest stripping at all, so a derived
 *    bare `A1-<date>` NEVER equalled the mirrored `A1-<date>-<8 hex>`, and every Xero
 *    daily batch double-reported (both directions) even without a midnight crossing.
 *
 * The derive-from-stamp fallback stays for pre-migration rows, which carry no ref and
 * never will.
 *
 * o3d-ecow: and THOSE rows are why the answer says which path produced it. A derived key is bare, the
 * Xero event it should match is digest-suffixed, and nothing here stripped a digest — so on Xero every
 * legacy daily batch reported TWICE, a `source_*_without_event` going forward and an
 * `event_without_source` coming back, with no midnight crossing needed. `digestBridged` marks the keys
 * that may be matched against a digest-stripped event id, and it is true ONLY on the derived path: a
 * persisted ref is the literal referenceId the batch wrote, so bridging it would widen the match past
 * the single journal it names. Exactly the split invariants.ts draws between its `exact` and
 * `digestBridged` indexes, from the same premise.
 */
function dailyBatchSourceEntityId(
  group: 'A1' | 'A2' | 'B',
  persistedReferenceId: string | null | undefined,
  stagedAt: Date | string | null,
): { sourceEntityId: string; digestBridged: boolean } | null {
  const persisted = persistedReferenceId?.trim()
  if (persisted) return { sourceEntityId: persisted, digestBridged: false }
  const key = dateKey(stagedAt)
  return key ? { sourceEntityId: `${group}-${key}`, digestBridged: true } : null
}

function eventKey(input: {
  externalSystem?: string | null
  type: string
  sourceEntityType: string
  sourceEntityId: string
}): string {
  return [
    input.externalSystem ?? '*',
    input.type,
    input.sourceEntityType,
    input.sourceEntityId,
  ].join('|')
}

function sourceKey(type: string, sourceEntityType: string, sourceEntityId: string): string {
  return [type, sourceEntityType, sourceEntityId].join('|')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function retrySyncTypes(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.flatMap((entry) => (
    isRecord(entry) && typeof entry.type === 'string' ? [entry.type] : []
  )))
}

function syncLogHasLiveEvidence(
  syncLogs: AccountingSyncLogRow[],
  params: { type: string; referenceType: string; referenceId: string },
): boolean {
  return syncLogs.some((log) => (
    log.type === params.type &&
    log.referenceType === params.referenceType &&
    log.referenceId === params.referenceId &&
    LIVE_SYNC_STATUSES.has(log.status)
  ))
}

function refundLabel(refund: SourceRefundRow): string {
  return refund.creditNoteNumber ?? refund.id
}

function orderLabel(order: SourceOrderRow): string {
  return order.orderNumber ?? order.externalOrderNumber ?? order.id
}

/**
 * The DISTINCT daily-batch journals a bare `<group>-<date>` key would match once the digest is
 * stripped off the events (o3d-ecow round 2, finding 3).
 *
 * The bridge takes the DIGEST off, and the digest is the only thing that tells two journals of the
 * same group and date apart. So on a day that was SPLIT — `A1-D-aaaa` and `A1-D-bbbb` — the bare key
 * matches both, and one of them satisfies the existence check the other should have failed:
 *
 *   forward  a legacy row whose journal (bbbb) was never mirrored is vouched for by aaaa's event, so
 *            a missing journal is not reported;
 *   reverse  a duplicate or orphaned event (bbbb) is vouched for by the source rows of aaaa, so the
 *            extra journal is not reported either.
 *
 * That is the same trap `dailyBatchLiveRefs` (daily-batch-reference.ts) refuses for the recreate
 * sweep, arriving here through the other door. It cannot be fixed by matching harder: a legacy row
 * carries no reference at all, so nothing in it can pick between the candidates. What it CAN do is
 * stop claiming to have decided — callers turn an ambiguous bridge into an explicit finding naming
 * every candidate, instead of a silent pass.
 */
function bridgedDailyBatchCandidates(
  accountingEvents: AccountingEventRow[],
  params: { type: string; sourceEntityType: string; sourceEntityId: string },
): string[] {
  const bareKey = sourceKey(params.type, params.sourceEntityType, params.sourceEntityId)
  const candidates = new Set<string>()
  for (const event of accountingEvents) {
    const stripped = stripDailyBatchDigest(event.sourceEntityId)
    if (sourceKey(event.type, event.sourceEntityType, stripped) === bareKey) candidates.add(event.sourceEntityId)
  }
  return [...candidates]
}

/** True when a bare key names more than one journal, so it can prove nothing about any of them. */
function bridgeIsAmbiguous(
  accountingEvents: AccountingEventRow[],
  params: { type: string; sourceEntityType: string; sourceEntityId: string },
): boolean {
  return bridgedDailyBatchCandidates(accountingEvents, params).length > 1
}

/** 'ambiguous' = a same-day split means the bridged match names several journals — see above. */
type EventExistence = 'found' | 'missing' | 'ambiguous'

function accountingEventExistence(
  accountingEvents: AccountingEventRow[],
  params: {
    type: string
    sourceEntityType: string
    sourceEntityId: string
    externalSystem?: string | null
    /** o3d-ecow: match a digest-suffixed event id against this bare key. Legacy derived keys only. */
    digestBridged?: boolean
  },
): EventExistence {
  const bridge = Boolean(params.digestBridged) && DAILY_BATCH_EVENT_TYPES.has(params.type)
  const idOf = (event: AccountingEventRow): string => (
    bridge ? stripDailyBatchDigest(event.sourceEntityId) : event.sourceEntityId
  )
  const exactKey = eventKey(params)
  const found = params.externalSystem
    ? accountingEvents.some((event) => eventKey({ ...event, sourceEntityId: idOf(event) }) === exactKey)
    : accountingEvents.some((event) => (
      sourceKey(event.type, event.sourceEntityType, idOf(event))
        === sourceKey(params.type, params.sourceEntityType, params.sourceEntityId)
    ))
  if (!found) return 'missing'
  // Only a BRIDGED match can be ambiguous: an exact key is the literal id its journal was created
  // under, so it names one journal by construction.
  if (bridge && bridgeIsAmbiguous(accountingEvents, params)) return 'ambiguous'
  return 'found'
}

function hasAccountingEvent(
  accountingEvents: AccountingEventRow[],
  params: {
    type: string
    sourceEntityType: string
    sourceEntityId: string
    externalSystem?: string | null
    digestBridged?: boolean
  },
): boolean {
  return accountingEventExistence(accountingEvents, params) !== 'missing'
}

function hasRefundCreditNoteEvidence(rows: AccountingReconciliationRows, refund: SourceRefundRow): boolean {
  // Any non-empty connector credit-note id is durable evidence. Sync writers
  // must clear this field if a remote credit note is voided or invalidated.
  if (refund.accountingCreditNoteId?.trim()) return true
  if (syncLogHasLiveEvidence(rows.syncLogs, {
    type: 'CREDIT_NOTE',
    referenceType: 'SalesOrderRefund',
    referenceId: refund.id,
  })) return true
  if (hasAccountingEvent(rows.accountingEvents, {
    type: 'CREDIT_NOTE',
    sourceEntityType: 'SalesOrderRefund',
    sourceEntityId: refund.id,
  })) return true
  return retrySyncTypes(refund.accountingRetrySyncs).has('CREDIT_NOTE')
}

function hasRefundReversalEvidence(rows: AccountingReconciliationRows, refund: SourceRefundRow): boolean {
  const retryTypes = retrySyncTypes(refund.accountingRetrySyncs)
  for (const type of REFUND_REVERSAL_TYPES) {
    if (syncLogHasLiveEvidence(rows.syncLogs, {
      type,
      referenceType: 'SalesOrderRefund',
      referenceId: refund.id,
    })) return true
    if (hasAccountingEvent(rows.accountingEvents, {
      type,
      sourceEntityType: 'SalesOrderRefund',
      sourceEntityId: refund.id,
    })) return true
    if (retryTypes.has(type)) return true
  }
  return false
}

function buildSummary(findings: AccountingReconciliationFinding[]): AccountingReconciliationReport['summary'] {
  return findings.reduce<AccountingReconciliationReport['summary']>(
    (summary, finding) => {
      summary.total += 1
      summary[finding.severity] += 1
      return summary
    },
    { total: 0, warning: 0, critical: 0 },
  )
}

export function reconciliationLookbackDate(days: number, now: Date = new Date()): Date {
  const date = new Date(now)
  date.setUTCDate(date.getUTCDate() - days)
  return date
}

function findingEntity(finding: AccountingReconciliationFinding): { entityType: string | null; entityId: string | null } {
  if (finding.accountingEventId) return { entityType: 'AccountingEvent', entityId: finding.accountingEventId }
  if (finding.syncLogId) return { entityType: 'AccountingSyncLog', entityId: finding.syncLogId }
  if (finding.refundId) return { entityType: 'SalesOrderRefund', entityId: finding.refundId }
  if (finding.shipmentId) return { entityType: 'Shipment', entityId: finding.shipmentId }
  if (finding.orderId) return { entityType: 'SalesOrder', entityId: finding.orderId }
  return { entityType: null, entityId: null }
}

function normalizeFindingStatus(value: unknown): AccountingReconciliationFindingStatus | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return ACCOUNTING_RECONCILIATION_FINDING_STATUSES.includes(normalized as AccountingReconciliationFindingStatus)
    ? normalized as AccountingReconciliationFindingStatus
    : null
}

/** The code an ambiguous same-day split bridge reports under, in both directions. */
export const DAILY_BATCH_SPLIT_BRIDGE_AMBIGUOUS = 'daily_batch_split_bridge_ambiguous'

/**
 * Report — ONCE per bare key — that a legacy digest bridge could not decide anything, because the
 * `<group>-<date>` it is reduced to names several journals.
 *
 * Deduped rather than emitted per row: a split day can carry thousands of staged orders, and a
 * finding per order would say the same unresolvable thing thousands of times and crowd out the rest
 * of the report (findings are capped per run). One finding naming every candidate journal is the
 * whole content.
 */
function addSplitBridgeAmbiguityFinding(
  findings: AccountingReconciliationFinding[],
  reported: Set<string>,
  accountingEvents: AccountingEventRow[],
  params: { type: string; sourceEntityType: string; sourceEntityId: string },
): void {
  const key = sourceKey(params.type, params.sourceEntityType, params.sourceEntityId)
  if (reported.has(key)) return
  reported.add(key)
  const candidates = bridgedDailyBatchCandidates(accountingEvents, params)
  findings.push({
    severity: 'warning',
    code: DAILY_BATCH_SPLIT_BRIDGE_AMBIGUOUS,
    message:
      `${candidates.length} daily batch journals share the legacy key ${params.sourceEntityId}, so whether `
      + 'each one was posted and mirrored cannot be established from rows that carry no batch reference',
    details: {
      type: params.type,
      sourceEntityType: params.sourceEntityType,
      sourceEntityId: params.sourceEntityId,
      candidateSourceEntityIds: candidates,
    },
  })
}

function addExpectedSourceEventFinding(
  findings: AccountingReconciliationFinding[],
  rows: AccountingReconciliationRows,
  reportedAmbiguousBridges: Set<string>,
  params: {
    code: string
    type: string
    sourceEntityType: string
    sourceEntityId: string
    digestBridged?: boolean
    message: string
    orderId?: string
    shipmentId?: string
    refundId?: string
    details: Record<string, unknown>
  },
): void {
  const existence = accountingEventExistence(rows.accountingEvents, params)
  if (existence === 'found') return
  if (existence === 'ambiguous') {
    // A journal DOES exist for this group and date — but the bare key matches several, so this row's
    // own journal may be any of them, including one that is missing. Neither "no event" nor "event
    // found" is true, and the round-1 bridge asserted the second (Codex r2 #3).
    addSplitBridgeAmbiguityFinding(findings, reportedAmbiguousBridges, rows.accountingEvents, params)
    return
  }
  findings.push({
    severity: 'warning',
    code: params.code,
    orderId: params.orderId,
    shipmentId: params.shipmentId,
    refundId: params.refundId,
    message: params.message,
    details: {
      type: params.type,
      sourceEntityType: params.sourceEntityType,
      sourceEntityId: params.sourceEntityId,
      ...params.details,
    },
  })
}

function addRowCapFindings(
  findings: AccountingReconciliationFinding[],
  rows: AccountingReconciliationRows,
): void {
  const cappedDatasets: Array<{ dataset: keyof AccountingReconciliationRows; count: number }> = [
    { dataset: 'salesOrders', count: rows.salesOrders.length },
    { dataset: 'shipments', count: rows.shipments.length },
    { dataset: 'refunds', count: rows.refunds.length },
    { dataset: 'syncLogs', count: rows.syncLogs.length },
    { dataset: 'accountingEvents', count: rows.accountingEvents.length },
    // Only when the dataset was actually read — see `revisionClaimLogs`.
    ...(rows.revisionClaimLogs ? [{ dataset: 'revisionClaimLogs' as const, count: rows.revisionClaimLogs.length }] : []),
  ]

  for (const { dataset, count } of cappedDatasets) {
    if (count < MAX_RECONCILIATION_ROWS) continue
    findings.push({
      severity: 'warning',
      code: 'reconciliation_row_cap_reached',
      message: `Accounting reconciliation reached the ${MAX_RECONCILIATION_ROWS} row cap for ${dataset}; report may be incomplete`,
      details: {
        dataset,
        scanned: count,
        limit: MAX_RECONCILIATION_ROWS,
      },
    })
  }
}

export function evaluateAccountingReconciliationRows(
  rows: AccountingReconciliationRows,
): AccountingReconciliationFinding[] {
  const findings: AccountingReconciliationFinding[] = []
  addRowCapFindings(findings, rows)
  const sourceKeys = new Set<string>()
  // o3d-ecow, the REVERSE direction. A legacy row can only offer the bare `<group>-<date>` it derives
  // from its stage stamp, so the digest has to come off the EVENT to meet it. Kept apart from
  // `sourceKeys` because only the derived keys may be matched that loosely — a persisted ref is
  // exact, and stripping a digest off an event to satisfy one would vouch for a different journal.
  const digestBridgedSourceKeys = new Set<string>()
  // Bare keys already reported as an unresolvable same-day split, so the report says it once.
  const reportedAmbiguousBridges = new Set<string>()
  const refundIds = new Set(rows.refunds.map((refund) => refund.id))
  const refundsByOrderId = new Map<string, SourceRefundRow[]>()
  for (const refund of rows.refunds) {
    const existing = refundsByOrderId.get(refund.orderId)
    if (existing) existing.push(refund)
    else refundsByOrderId.set(refund.orderId, [refund])
  }
  const postedShipmentOrderIds = new Set(
    rows.shipments
      .filter((shipment) => shipment.shipmentJournalDate != null)
      .map((shipment) => shipment.orderId),
  )

  for (const order of rows.salesOrders) {
    const label = orderLabel(order)
    const a1SourceEntityId = dailyBatchSourceEntityId('A1', order.revenueDeferredBatchRef, order.revenueDeferredDate)
    if (a1SourceEntityId) {
      const { sourceEntityId, digestBridged } = a1SourceEntityId
      const key = sourceKey('DAILY_BATCH_REVENUE_DEFERRAL', 'DailyBatch', sourceEntityId)
      sourceKeys.add(key)
      if (digestBridged) digestBridgedSourceKeys.add(key)
      addExpectedSourceEventFinding(findings, rows, reportedAmbiguousBridges, {
        code: 'source_order_revenue_deferral_without_event',
        type: 'DAILY_BATCH_REVENUE_DEFERRAL',
        sourceEntityType: 'DailyBatch',
        sourceEntityId,
        digestBridged,
        orderId: order.id,
        message: `Sales order ${label} has A1 revenue deferral but no mirrored accounting event`,
        details: { status: order.status, revenueDeferredDate: order.revenueDeferredDate },
      })
    }

    const a2SourceEntityId = dailyBatchSourceEntityId('A2', order.inventoryAllocatedBatchRef, order.inventoryAllocatedDate)
    if (a2SourceEntityId) {
      const { sourceEntityId, digestBridged } = a2SourceEntityId
      const key = sourceKey('DAILY_BATCH_INVENTORY_ALLOC', 'DailyBatch', sourceEntityId)
      sourceKeys.add(key)
      if (digestBridged) digestBridgedSourceKeys.add(key)
      addExpectedSourceEventFinding(findings, rows, reportedAmbiguousBridges, {
        code: 'source_order_inventory_allocation_without_event',
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        sourceEntityType: 'DailyBatch',
        sourceEntityId,
        digestBridged,
        orderId: order.id,
        message: `Sales order ${label} has A2 inventory allocation but no mirrored accounting event`,
        details: { status: order.status, inventoryAllocatedDate: order.inventoryAllocatedDate },
      })
    }

    const orderRefunds = refundsByOrderId.get(order.id) ?? []
    const hasPostedAccountingState = Boolean(a1SourceEntityId || a2SourceEntityId || postedShipmentOrderIds.has(order.id))
    if (order.status === 'CANCELLED' && hasPostedAccountingState) {
      const hasReversalEvidence = orderRefunds.some((refund) => hasRefundReversalEvidence(rows, refund))
      if (!hasReversalEvidence) {
        findings.push({
          severity: 'critical',
          code: 'terminal_cancelled_order_missing_reversal_evidence',
          orderId: order.id,
          message: `Cancelled sales order ${label} has posted accounting state but no reversal evidence`,
          details: {
            status: order.status,
            revenueDeferredDate: order.revenueDeferredDate,
            inventoryAllocatedDate: order.inventoryAllocatedDate,
            hasPostedShipment: postedShipmentOrderIds.has(order.id),
            refundIds: orderRefunds.map((refund) => refund.id),
          },
        })
      }
    }

    if (order.refundStatus !== 'NONE') {
      for (const refund of orderRefunds) {
        const hasCreditNoteEvidence = hasRefundCreditNoteEvidence(rows, refund)
        const hasReversalEvidence = hasRefundReversalEvidence(rows, refund)
        if (!hasCreditNoteEvidence) {
          findings.push({
            severity: 'critical',
            code: 'terminal_refunded_order_missing_credit_note_evidence',
            orderId: order.id,
            refundId: refund.id,
            message: `Refunded sales order ${label} has refund ${refundLabel(refund)} but no credit-note evidence`,
            details: {
              status: order.status,
              creditNoteNumber: refund.creditNoteNumber,
              accountingCreditNoteId: refund.accountingCreditNoteId,
              totalBase: decimalToNumber(refund.totalBase),
            },
          })
        }

        // Zero-total refunds post no COGS/unearned-revenue reversal; only
        // positive-value refunds require reversal evidence. scjz.70/.71: a fully-shipped
        // chargeback stages none (credit note only) so it is exempt; a partial/deferred
        // chargeback that staged an UNEARNED_REV_REVERSAL still owes that evidence.
        // reversalStaged is a DURABLE per-refund flag set at staging time
        // (accountingRetrySyncs is cleared once syncs queue, so it can't carry this).
        const chargebackExemptReversal = Boolean(refund.chargeback) && !refund.reversalStaged
        if (postedShipmentOrderIds.has(order.id) && decimalToNumber(refund.totalBase) > 0 && !hasReversalEvidence && !chargebackExemptReversal) {
          findings.push({
            severity: 'critical',
            code: 'terminal_refunded_order_missing_reversal_evidence',
            orderId: order.id,
            refundId: refund.id,
            message: `Refunded sales order ${label} has refund ${refundLabel(refund)} but no reversal evidence`,
            details: {
              status: order.status,
              creditNoteNumber: refund.creditNoteNumber,
              totalBase: decimalToNumber(refund.totalBase),
              hasPostedShipment: true,
            },
          })
        }
      }
    }
  }

  for (const shipment of rows.shipments) {
    const groupB = dailyBatchSourceEntityId('B', shipment.shipmentJournalBatchRef, shipment.shipmentJournalDate)
    if (!groupB) continue
    const { sourceEntityId, digestBridged } = groupB
    const key = sourceKey('DAILY_BATCH_GROUP_B', 'DailyBatch', sourceEntityId)
    sourceKeys.add(key)
    if (digestBridged) digestBridgedSourceKeys.add(key)
    addExpectedSourceEventFinding(findings, rows, reportedAmbiguousBridges, {
      code: 'source_shipment_without_event',
      type: 'DAILY_BATCH_GROUP_B',
      sourceEntityType: 'DailyBatch',
      sourceEntityId,
      digestBridged,
      orderId: shipment.orderId,
      shipmentId: shipment.id,
      message: `Shipment ${shipment.id} has Group B posting state but no mirrored accounting event`,
      details: { shipmentJournalDate: shipment.shipmentJournalDate },
    })
  }

  for (const refund of rows.refunds) {
    const expectedRefundTypes = new Set([
      ...rows.syncLogs
        .filter((log) => log.referenceType === 'SalesOrderRefund' && log.referenceId === refund.id && REFUND_REVERSAL_TYPES.has(log.type))
        .map((log) => log.type),
      ...[...retrySyncTypes(refund.accountingRetrySyncs)].filter((type) => REFUND_REVERSAL_TYPES.has(type)),
    ])

    for (const type of expectedRefundTypes) {
      sourceKeys.add(sourceKey(type, 'SalesOrderRefund', refund.id))
      addExpectedSourceEventFinding(findings, rows, reportedAmbiguousBridges, {
        code: 'source_refund_without_event',
        type,
        sourceEntityType: 'SalesOrderRefund',
        sourceEntityId: refund.id,
        orderId: refund.orderId,
        refundId: refund.id,
        message: `Refund ${refundLabel(refund)} has ${type} sync evidence but no mirrored accounting event`,
        details: { creditNoteNumber: refund.creditNoteNumber },
      })
    }
  }

  for (const log of rows.syncLogs) {
    if (log.type === 'COGS_REVERSAL' && log.referenceType === 'Shipment') {
      sourceKeys.add(sourceKey(log.type, log.referenceType, log.referenceId))
    }
    if (!isMirrorableAccountingSyncType(log.type)) continue
    if (hasAccountingEvent(rows.accountingEvents, {
      externalSystem: log.connector,
      type: log.type,
      sourceEntityType: log.referenceType,
      sourceEntityId: log.referenceId,
    })) continue

    findings.push({
      severity: 'warning',
      code: 'old_sync_log_without_mirrored_event',
      syncLogId: log.id,
      message: `Accounting sync log ${log.id} has no mirrored accounting event`,
      details: {
        connector: log.connector,
        type: log.type,
        status: log.status,
        referenceType: log.referenceType,
        referenceId: log.referenceId,
      },
    })
  }

  for (const event of rows.accountingEvents) {
    if (event.status === 'POSTED' && !event.externalId?.trim()) {
      findings.push({
        severity: 'critical',
        code: 'posted_event_without_external_id',
        accountingEventId: event.id,
        message: `Posted accounting event ${event.id} has no external ID`,
        details: {
          type: event.type,
          sourceEntityType: event.sourceEntityType,
          sourceEntityId: event.sourceEntityId,
          externalSystem: event.externalSystem,
        },
      })
    }

    if (!SOURCE_TRACKED_EVENT_TYPES.has(event.type)) continue
    const key = sourceKey(event.type, event.sourceEntityType, event.sourceEntityId)
    // o3d-ecow: ...or a legacy bare key that this digest-suffixed id is the Xero spelling of.
    const bridgedKey = DAILY_BATCH_EVENT_TYPES.has(event.type) && event.sourceEntityType === 'DailyBatch'
      ? sourceKey(event.type, event.sourceEntityType, stripDailyBatchDigest(event.sourceEntityId))
      : null
    const isKnownRefund = event.sourceEntityType === 'SalesOrderRefund' && refundIds.has(event.sourceEntityId)
    // ...but a bare key that names SEVERAL journals vouches for none of them (r2 #3). Rescuing this
    // event on it would let a surviving split's source rows account for a duplicate or orphaned one,
    // so an ambiguous bridge reports what it cannot decide instead of quietly deciding it.
    const bareParams = {
      type: event.type,
      sourceEntityType: event.sourceEntityType,
      sourceEntityId: stripDailyBatchDigest(event.sourceEntityId),
    }
    const bridgeOffered = bridgedKey !== null && digestBridgedSourceKeys.has(bridgedKey)
    const bridgeAmbiguous = bridgeOffered && bridgeIsAmbiguous(rows.accountingEvents, bareParams)
    const bridgeRescues = bridgeOffered && !bridgeAmbiguous
    if (bridgeAmbiguous && !sourceKeys.has(key)) {
      addSplitBridgeAmbiguityFinding(findings, reportedAmbiguousBridges, rows.accountingEvents, bareParams)
      continue
    }
    if (!sourceKeys.has(key) && !bridgeRescues && !isKnownRefund) {
      findings.push({
        severity: 'warning',
        code: 'event_without_source',
        accountingEventId: event.id,
        message: `Accounting event ${event.id} has no matching source state`,
        details: {
          type: event.type,
          sourceEntityType: event.sourceEntityType,
          sourceEntityId: event.sourceEntityId,
          externalSystem: event.externalSystem,
        },
      })
    }
  }

  const eventReferences = new Map<string, string[]>()
  for (const event of rows.accountingEvents) {
    if (!event.externalSystem?.trim() || !event.externalId?.trim()) continue
    const key = `${event.externalSystem}|${event.externalId}`
    eventReferences.set(key, [...(eventReferences.get(key) ?? []), event.id])
  }
  // o3d-cvj9: a *_INVOICE_UPDATE sync log posts a REVISION of a document that already exists, and
  // the connector returns the same external id it returned for the create — so a create plus its
  // revisions legitimately share one external reference. Grouping the documents each reference is
  // claimed by, and counting the CREATE rows separately, keeps both real duplicates reportable:
  // one reference spanning two source documents, or one document posted by two create rows.
  //
  // o3d-cvj9 r2: and the FAMILY, because a shared source key is not the same thing as a shared
  // document. `referenceType`/`referenceId` name the source row a sync log was raised from, and one
  // source row can feed more than one kind of external document — so an exemption resting on the
  // source key alone waves through pairings the mirror itself refuses (a sales invoice and a
  // purchase bill are different ledger documents however their source rows are keyed, and
  // `resolveDocumentRevisionExternalIdClaim` will not let one take the other's id). Requiring a
  // single family makes reconciliation exempt EXACTLY what the mirror permits and no more.
  const syncLogReferences = new Map<
    string,
    { logIds: string[]; documents: Set<string>; families: Set<string>; creates: number }
  >()
  for (const log of rows.syncLogs) {
    if (!log.connector.trim() || !log.externalTransactionId?.trim()) continue
    const key = `${log.connector}|${log.externalTransactionId}`
    const entry = syncLogReferences.get(key)
      ?? { logIds: [], documents: new Set<string>(), families: new Set<string>(), creates: 0 }
    entry.logIds.push(log.id)
    entry.documents.add(`${log.referenceType}\x00${log.referenceId}`)
    // A type outside every revision family is its own family, so it can never be exempted as
    // somebody else's revision — the fallback has to be the TYPE, not a shared "none" bucket.
    entry.families.add(accountingDocumentRevisionFamily(log.type) ?? `type\x00${log.type}`)
    if (!isDocumentRevisionAccountingSyncType(log.type)) entry.creates += 1
    syncLogReferences.set(key, entry)
  }

  for (const [reference, eventIds] of eventReferences) {
    if (eventIds.length <= 1) continue
    findings.push({
      severity: 'critical',
      code: 'duplicate_external_reference',
      message: `External accounting reference ${reference} appears on ${eventIds.length} accounting events`,
      details: {
        externalReference: reference,
        accountingEventIds: eventIds,
        syncLogIds: [],
      },
    })
  }

  for (const [reference, entry] of syncLogReferences) {
    if (entry.logIds.length <= 1) continue
    if (entry.documents.size <= 1 && entry.families.size <= 1 && entry.creates <= 1) continue
    findings.push({
      severity: 'critical',
      code: 'duplicate_external_reference',
      message: `External accounting reference ${reference} appears on ${entry.logIds.length} sync logs`,
      details: {
        externalReference: reference,
        accountingEventIds: [],
        syncLogIds: entry.logIds,
      },
    })
  }

  addAssumedRevisionOrderFindings(findings, rows)

  return findings
}

/**
 * o3d-cvj9 r7 (Codex r7, HIGH) — THE OPERATOR SURFACE FOR AN IDENTIFIER THAT MOVED ON A GUESS.
 *
 * Rounds 3-6 made the live mirror's assumption honest: the verdict carries the basis it was reached
 * on and whether that basis established the order, and an assumed handover records both. r6 then
 * named the gap it had left — the assumption lives in an audit row's metadata, and NOTHING LISTS
 * THE DOCUMENTS WHOSE IDENTIFIER MOVED ON ONE. This closes that, because a guess about which row
 * describes a real accounting document is only defensible if a person can go and check it.
 *
 * The finding is a WARNING, not a critical. Nothing here is known to be broken: the handover may
 * well be right, and in the common shape of both assuming rules it is (see the `acceptAssumedOrder`
 * block in the mirror). What is true is that it was not verified against the external system, and
 * only a person with access to that system can verify it. `posted_event_without_external_id` next
 * to it is the critical, because a posted row with no document id IS a defect.
 *
 * One finding per handover, keyed to the row that now HOLDS the identifier — the row a reader is
 * being asked to confirm describes the document — with the row that released it, the document id and
 * the basis alongside, so the check can be made without opening the audit table.
 */
function addAssumedRevisionOrderFindings(
  findings: AccountingReconciliationFinding[],
  rows: AccountingReconciliationRows,
): void {
  for (const log of rows.revisionClaimLogs ?? []) {
    // The dataset is selected on this action, but it is asserted rather than assumed: the row shape
    // is shared with every other accounting event log, and a caller that widened the query must not
    // silently start reporting established handovers as guesses.
    if (log.action !== ASSUMED_REVISION_ORDER_TAKEOVER_ACTION) continue
    const metadata = (log.metadata ?? {}) as {
      connector?: unknown
      externalId?: unknown
      supersededByEventId?: unknown
      orderingBasis?: unknown
      syncType?: unknown
      referenceType?: unknown
      referenceId?: unknown
    }
    const holdingEventId = typeof metadata.supersededByEventId === 'string' ? metadata.supersededByEventId : null
    const externalId = typeof metadata.externalId === 'string' ? metadata.externalId : null
    findings.push({
      severity: 'warning',
      code: 'document_claim_moved_on_assumed_order',
      // Keyed to the taker when the trail names one; otherwise to the row that released the claim,
      // so a malformed entry is still traceable to a document rather than dropped.
      accountingEventId: holdingEventId ?? log.accountingEventId,
      message: `External accounting document ${externalId ?? '(unknown)'} was reassigned to a later `
        + 'revision on an assumed order; confirm which revision the document actually reflects',
      details: {
        connector: typeof metadata.connector === 'string' ? metadata.connector : null,
        externalId,
        orderingBasis: typeof metadata.orderingBasis === 'string' ? metadata.orderingBasis : null,
        // Both sides by name: `releasedByEventId` no longer holds the id, `holdingEventId` does.
        releasedByEventId: log.accountingEventId,
        holdingEventId,
        syncType: typeof metadata.syncType === 'string' ? metadata.syncType : null,
        referenceType: typeof metadata.referenceType === 'string' ? metadata.referenceType : null,
        referenceId: typeof metadata.referenceId === 'string' ? metadata.referenceId : null,
        movedAt: log.createdAt instanceof Date ? log.createdAt.toISOString() : log.createdAt,
      },
    })
  }
}

export async function collectAccountingReconciliationRows(
  client: AccountingReconciliationClient = db as unknown as AccountingReconciliationClient,
  options: { lookbackDays?: number; toDate?: Date } = {},
): Promise<AccountingReconciliationRows> {
  const fromDate = reconciliationLookbackDate(
    options.lookbackDays ?? DEFAULT_RECONCILIATION_LOOKBACK_DAYS,
    options.toDate,
  )
  const [salesOrders, shipments, refunds, syncLogs, accountingEvents, revisionClaimLogs] = await Promise.all([
    client.salesOrder.findMany({
      where: {
        OR: [
          { revenueDeferredDate: { gte: fromDate } },
          { inventoryAllocatedDate: { gte: fromDate } },
          { status: { in: [...TERMINAL_SALES_ORDER_STATUSES] }, updatedAt: { gte: fromDate } },
          // Refund state is orthogonal to the lifecycle status now, so a recently
          // refunded order may sit in a non-terminal status (e.g. PROCESSING). Always
          // scan refunded orders so their credit-note/reversal evidence is checked.
          { refundStatus: { not: 'NONE' }, updatedAt: { gte: fromDate } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        status: true,
        refundStatus: true,
        revenueDeferredDate: true,
        inventoryAllocatedDate: true,
        // o3d-0qoo: the source key is built from these when present; omitting them
        // silently demotes every row to the derive-from-stamp fallback.
        revenueDeferredBatchRef: true,
        inventoryAllocatedBatchRef: true,
      },
    }),
    client.shipment.findMany({
      where: { shipmentJournalDate: { gte: fromDate } },
      orderBy: { shipmentJournalDate: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        orderId: true,
        shipmentJournalDate: true,
        shipmentJournalBatchRef: true,
      },
    }),
    client.salesOrderRefund.findMany({
      where: {
        refundedAt: { gte: fromDate },
      },
      orderBy: { refundedAt: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        orderId: true,
        creditNoteNumber: true,
        accountingCreditNoteId: true,
        totalBase: true,
        accountingRetrySyncs: true,
        chargeback: true,
        reversalStaged: true,
      },
    }),
    client.accountingSyncLog.findMany({
      where: {
        OR: [
          { status: { in: ['PENDING', 'PROCESSING'] } },
          { status: { in: ['SYNCED', 'FAILED'] }, createdAt: { gte: fromDate } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        connector: true,
        type: true,
        status: true,
        referenceType: true,
        referenceId: true,
        externalTransactionId: true,
        payload: true,
      },
    }),
    client.accountingEvent.findMany({
      where: {
        OR: [
          { businessDate: { gte: fromDate } },
          { status: { not: 'POSTED' } },
        ],
      },
      orderBy: { businessDate: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        type: true,
        sourceEntityType: true,
        sourceEntityId: true,
        businessDate: true,
        status: true,
        idempotencyKey: true,
        externalSystem: true,
        externalId: true,
      },
    }),
    // o3d-cvj9 r7: the handovers the live mirror made on an order nothing established. Selected on
    // the ACTION alone — not by joining the events above — because the row that carries the entry is
    // the SUPERSEDED holder, and whether that row was loaded above depends on a business date that
    // has nothing to do with when the claim moved. Backed by @@index([action, createdAt]) on
    // AccountingEventLog.
    //
    // Bounded by the report's own lookback like every other dataset here. An unbounded read would
    // grow monotonically and re-report a handover that was checked and accepted years ago, and a
    // finding that can never stop appearing stops being read at all — which is the failure mode this
    // whole surface exists to avoid.
    client.accountingEventLog.findMany({
      where: {
        action: ASSUMED_REVISION_ORDER_TAKEOVER_ACTION,
        createdAt: { gte: fromDate },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        accountingEventId: true,
        action: true,
        metadata: true,
        createdAt: true,
      },
    }),
  ])

  return { salesOrders, shipments, refunds, syncLogs, accountingEvents, revisionClaimLogs }
}

export async function runAccountingReconciliationReport(options: {
  client?: AccountingReconciliationClient
  persistenceClient?: AccountingReconciliationPersistenceClient
  lookbackDays?: number
  persist?: boolean
  now?: () => Date
} = {}): Promise<AccountingReconciliationReport> {
  const checkedAt = options.now?.() ?? new Date()
  const fromDate = reconciliationLookbackDate(options.lookbackDays ?? DEFAULT_RECONCILIATION_LOOKBACK_DAYS, checkedAt)
  const rows = await collectAccountingReconciliationRows(
    options.client ?? (db as unknown as AccountingReconciliationClient),
    { lookbackDays: options.lookbackDays, toDate: checkedAt },
  )
  const findings = evaluateAccountingReconciliationRows(rows)

  const report: AccountingReconciliationReport = {
    checkedAt: checkedAt.toISOString(),
    fromDate: fromDate.toISOString(),
    toDate: checkedAt.toISOString(),
    findings,
    summary: buildSummary(findings),
  }

  if (!options.persist) return report
  return persistAccountingReconciliationReport(
    report,
    options.persistenceClient ?? (db as unknown as AccountingReconciliationPersistenceClient),
  )
}

export async function persistAccountingReconciliationReport(
  report: AccountingReconciliationReport,
  client: AccountingReconciliationPersistenceClient = db as unknown as AccountingReconciliationPersistenceClient,
): Promise<AccountingReconciliationReport> {
  const persist = async (tx: AccountingReconciliationPersistenceClient) => {
    const run = await tx.accountingReconciliationRun.create({
      data: {
        fromDate: report.fromDate ? new Date(report.fromDate) : null,
        toDate: report.toDate ? new Date(report.toDate) : null,
        status: 'COMPLETED' satisfies AccountingReconciliationRunStatus,
        totalCount: report.summary.total,
        warningCount: report.summary.warning,
        criticalCount: report.summary.critical,
      },
    })

    if (report.findings.length > 0) {
      await tx.accountingReconciliationFinding.createMany({
        data: report.findings.map((finding) => {
          const entity = findingEntity(finding)
          return {
            runId: run.id,
            severity: finding.severity,
            code: finding.code,
            entityType: entity.entityType,
            entityId: entity.entityId,
            message: finding.message,
            details: toJsonInputValue(finding.details),
            status: 'OPEN' satisfies AccountingReconciliationFindingStatus,
          }
        }),
      })
    }

    return {
      ...report,
      runId: run.id,
      persisted: true,
    }
  }

  return client.$transaction ? client.$transaction(persist) : persist(client)
}

export async function listAccountingReconciliationRuns(
  client: AccountingReconciliationPersistenceClient = db as unknown as AccountingReconciliationPersistenceClient,
  options: { limit?: number; includeFindings?: boolean } = {},
): Promise<PersistedAccountingReconciliationRun[]> {
  const take = Math.min(Math.max(options.limit ?? 25, 1), MAX_RECONCILIATION_LIST_RUNS)
  return client.accountingReconciliationRun.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    include: options.includeFindings
      ? {
          findings: {
            orderBy: { createdAt: 'asc' },
            take: MAX_RECONCILIATION_FINDINGS_PER_RUN,
          },
          _count: { select: { findings: true } },
        }
      : { _count: { select: { findings: true } } },
  })
}

export type AccountingReconciliationFindingStatusUpdate = {
  finding: PersistedAccountingReconciliationFinding
  priorStatus: AccountingReconciliationFindingStatus
}

export async function updateAccountingReconciliationFindingStatus(
  findingId: string,
  status: unknown,
  actorId?: string | null,
  client: AccountingReconciliationPersistenceClient = db as unknown as AccountingReconciliationPersistenceClient,
): Promise<AccountingReconciliationFindingStatusUpdate> {
  const normalized = normalizeFindingStatus(status)
  if (!normalized) {
    throw new Error(`Invalid accounting reconciliation finding status: ${String(status)}`)
  }

  const update = async (tx: AccountingReconciliationPersistenceClient) => {
    const prior = await tx.accountingReconciliationFinding.findUnique({
      where: { id: findingId },
    })
    if (!prior) throw new Error(`Accounting reconciliation finding not found: ${findingId}`)

    const priorStatus = normalizeFindingStatus(prior.status)
    if (!priorStatus) {
      throw new Error(`Invalid existing accounting reconciliation finding status: ${prior.status}`)
    }

    const finding = await tx.accountingReconciliationFinding.update({
      where: { id: findingId },
      data: {
        status: normalized,
        statusUpdatedAt: new Date(),
        statusUpdatedBy: actorId ?? null,
      },
    })

    return { finding, priorStatus }
  }

  return client.$transaction ? client.$transaction(update) : update(client)
}
