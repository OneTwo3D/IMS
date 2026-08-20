import type { Prisma } from '@/app/generated/prisma/client'
import { describeSyncRowSettleability } from '@/lib/domain/accounting/sync-row-settlement'

/**
 * o3d-osl8 item 1 — the STRANDED-ROW read model.
 *
 * THE PROBLEM. Every accounting log view in the product is scoped to the ACTIVE connector:
 * getAccountingSyncLogs resolves the active connector before reading, and getXeroSyncLogs /
 * getQuickBooksSyncLogs hard-filter `connector: 'xero' | 'quickbooks'`. An unresolved
 * AccountingSyncLog row left behind on a RETIRED connector therefore appears in NO log view at
 * all — its only trace is the integer in the connector-orphan banner.
 *
 * o3d-osl8 is explicit that an aggregate count is NOT a remedy; that was the specific
 * criticism. An operator cannot act on "3". They need to see WHICH rows, on WHICH connector, of
 * WHICH type, against WHICH reference, and HOW LONG they have been stuck — which is what this
 * module produces.
 *
 * WHAT THIS IS NOT. Nothing here mutates a row: this module decides what is LISTED and how it is
 * described, never what happens to it. The per-row remedy now exists — settleAccountingSyncRow in
 * app/actions/accounting-settlement.ts (o3d-nf9i / o3d-osl8 item 2) — so each row now also carries
 * whether that control applies to it and, when it does not, WHY. An omitted control with no reason
 * reads as "there is nothing to do here", which is the opposite of the truth for a row the operator
 * can see and cannot clear.
 *
 * `settleable` is a UI affordance, NOT a permission and NOT a guarantee: it says the row's status
 * and type admit an operator assertion and that it carries an attempt the assertion can be fenced
 * to. Whether the assertion actually lands is decided by applyFencedAttemptDecision at write time,
 * against the state then — never by this flag.
 *
 * Pure functions only, so the scoping rule — the part that must not drift back to being
 * active-connector-scoped — is unit-testable without a database, exactly as connector-orphans.ts
 * and followup-idempotency.ts are.
 */

/** Statuses a stranded row can be in and still be unresolved work. */
export const STRANDED_ACCOUNTING_SYNC_STATUSES = ['PENDING', 'PROCESSING', 'FAILED'] as const

/**
 * Rows that no processor will ever pick up AND no log view will ever show: unresolved work on
 * a connector other than the active one. When no accounting connector is enabled at all, every
 * unresolved row qualifies — nothing is going to process any of them.
 *
 * DELIBERATELY NOT scoped to the active connector. That inversion is the entire point of the
 * module; scoping it would reproduce the blind spot it exists to remove.
 *
 * Backed by @@index([connector, status, createdAt]) on AccountingSyncLog.
 */
export function buildStrandedSyncRowWhere(activeConnector: string | null): Prisma.AccountingSyncLogWhereInput {
  const status = { in: [...STRANDED_ACCOUNTING_SYNC_STATUSES] }
  return activeConnector ? { status, connector: { not: activeConnector } } : { status }
}

/**
 * Oldest first — the longest-stuck row is the one most likely to be blocking a delete.
 *
 * Tie-broken on `id`. `createdAt` ALONE is not a total order: rows queued inside one transaction
 * share a timestamp, so the database is free to return them in any order, and a truncated page
 * would then be non-deterministic between renders — the same row could appear, vanish and
 * reappear across refreshes. `id` is unique, so the pair is total.
 */
export function buildStrandedSyncRowOrderBy(): Prisma.AccountingSyncLogOrderByWithRelationInput[] {
  return [{ createdAt: 'asc' }, { id: 'asc' }]
}

/** The columns the loader selects — the row as it comes off the database. */
export type StrandedSyncRowSource = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  createdAt: Date
  attemptRevision: number
}

/** The row as the UI receives it: identifying detail, plus how long it has been stuck. */
export type StrandedSyncRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  createdAt: string
  /** Whole days since the row was queued — the "how long has this been stuck" the count hid. */
  ageDays: number
  /**
   * o3d-e2mz: the attempt this row is currently on. Carried to the UI because a settlement must name
   * the attempt it was made about, and the operator cannot name what they were never shown. 0 means
   * no fence-aware processor has ever claimed it, which is every QuickBooks row and every row
   * predating the fence.
   */
  attemptRevision: number
  /** Whether the per-row settlement control applies. See the module comment: an affordance, not a guarantee. */
  settleable: boolean
  /**
   * Why not, when `settleable` is false. Without this the UI silently omits the control and the
   * operator is left to guess whether the row is fine or merely unfixable from here.
   */
  notSettleableReason: string | null
  /**
   * What the operator needs to know BEFORE asserting, when the row IS settleable. Facts about what
   * can still contradict them — not a recommendation.
   */
  settlementCaveat: string | null
}

export function describeStrandedSyncRow(row: StrandedSyncRowSource, now: Date): StrandedSyncRow {
  const ageMs = Math.max(0, now.getTime() - row.createdAt.getTime())
  return {
    id: row.id,
    connector: row.connector,
    type: row.type,
    status: row.status,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    externalTransactionId: row.externalTransactionId,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    ageDays: Math.floor(ageMs / 86_400_000),
    attemptRevision: row.attemptRevision,
    // ONE implementation of "which rows get a control", shared with the active connector's sync log.
    ...describeSyncRowSettleability(row),
  }
}

/** One page of stranded rows, with whether the list was cut short. */
export type StrandedSyncRowPage = {
  rows: StrandedSyncRow[]
  /** True when stranded rows exist BEYOND the ones returned. */
  hasMore: boolean
}

/**
 * Turn a `take + 1` read into a page of `take` rows plus a truthful "there are more" flag.
 *
 * WHY `take + 1`. Truncation still has to be REPORTED, and the reason has only shifted rather than
 * gone away. The per-row settlement control now exists, so an operator CAN clear rows from the front
 * of this list — but only the settleable ones. A DAILY_BATCH row, a row at attempt revision 0
 * (every QuickBooks row, permanently), or a PENDING row that no sweep reaches is not clearable from
 * this page at all, and a run of those at the head of the list starves every newer row behind them
 * for as long as they sit there. A bare `take` with no truncation signal would hide that. The extra
 * row is how the UI gets to say so.
 */
export function pageStrandedSyncRows(
  sourceRows: StrandedSyncRowSource[],
  take: number,
  now: Date,
): StrandedSyncRowPage {
  const hasMore = sourceRows.length > take
  return {
    rows: (hasMore ? sourceRows.slice(0, take) : sourceRows).map((row) => describeStrandedSyncRow(row, now)),
    hasMore,
  }
}

/** What the loader returns: the page, plus how many stranded rows exist in total. */
export type StrandedSyncRowsResult = StrandedSyncRowPage & {
  /**
   * Total stranded rows matching the filter. Equal to `rows.length` when the list is complete;
   * counted separately only when it is not, so the untruncated case stays a single query.
   */
  total: number
}
