import type { Prisma } from '@/app/generated/prisma/client'

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
 * WHAT THIS IS NOT. Nothing here settles, cancels, retries or otherwise mutates a row. There is
 * no per-row remedy in this module and none anywhere else yet: the rows are LISTED, with enough
 * identity to go and look in the accounting system. Safely terminalising a PROCESSING row needs
 * an immutable claim/attempt generation on the row that the connectors' writeback also
 * compare-and-sets on (o3d-e2mz), so a settlement can fence one specific attempt and a late
 * writeback loses. Until that exists there is deliberately no `settleable` flag and no refusal
 * reason here: both would describe a capability that does not exist.
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
 * WHY `take + 1`. The list is READ-ONLY: there is no remedy here for a FAILED row (that needs
 * the claim generation, o3d-e2mz), so the oldest rows cannot be cleared by anything the operator
 * does on this page. A bare `take` with no truncation signal therefore means the oldest N rows
 * can starve every newer one FOREVER — a stranded row created today is invisible for as long as
 * 50 older FAILED rows sit in front of it, and nothing will ever move them. The extra row is how
 * the UI gets to say so.
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
