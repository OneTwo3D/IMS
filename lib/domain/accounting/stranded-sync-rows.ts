import type { Prisma } from '@/app/generated/prisma/client'
import { describeStillClaimableStrandedRow } from '@/lib/domain/accounting/sync-row-claimability'
import {
  describeSyncRowSettleability,
  type SettlementOutcome,
} from '@/lib/domain/accounting/sync-row-settlement'

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
 * to — or, for a row that carries none, that its attempt can be ADOPTED because no claim path for
 * its connector is left open. That second case is NOT "the connector is not the active one" (round
 * 5, Codex HIGH #1): the manual Sync action for each connector gates on its own sync toggle and
 * never resolves the active connector, so listing a row here proves only that it is invisible
 * elsewhere, not that it is finished with. `isStrandedRowUnclaimable` decides it; this module asks.
 * Whether the assertion actually lands is decided by applyFencedAttemptDecision at write time,
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
  /**
   * o3d-nf9i r3: true when this row is settleable only by ADOPTION — it carries no attempt revision
   * and is settleable solely because nothing on a retired connector can ever claim it. Carried so
   * the operator is told they are minting the attempt identity, not naming one they were shown.
   */
  requiresAttemptAdoption: boolean
  /**
   * o3d-jit6 (Codex r1 finding 3): which assertions this row admits. `['POSTED']` for a DAILY_BATCH
   * row — recording the journal's id is safe and is the only exit such a row has; cancelling it is
   * what would let the recreate sweep post the batch twice.
   */
  settleableOutcomes: readonly SettlementOutcome[]
}

/**
 * Whether a row on this connector can still be claimed by anything — the loader's answer, computed
 * from the installation's sync toggles by `isStrandedRowUnclaimable`.
 *
 * A FUNCTION rather than a boolean because a single page can carry rows from more than one
 * connector (with no accounting plugin enabled at all, every unresolved row is stranded), and one
 * connector being quiesced says nothing about the other.
 */
export type StrandedRowUnclaimable = (connector: string) => boolean

export function describeStrandedSyncRow(
  row: StrandedSyncRowSource,
  now: Date,
  unclaimable: StrandedRowUnclaimable,
): StrandedSyncRow {
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
    //
    // `unclaimable` IS ASKED PER CONNECTOR, and rounds 3 and 4 got this wrong (round 5, Codex
    // HIGH #1). It used to be passed `true` unconditionally, argued as a property of this LIST:
    // buildStrandedSyncRowWhere selects only rows whose connector is NOT the active one, so —
    // the argument went — nothing that participates in the attempt fence can claim anything here.
    //
    // The rows this list exists for are precisely the counter-example. The active connector comes
    // from the PLUGIN flags, Xero-first; `triggerQuickBooksSync` gates on `quickbooks_sync_enabled`
    // and NOTHING ELSE, so with Xero enabled beside a still-enabled QuickBooks — the exact state the
    // QuickBooks unrecorded-post record tells an operator to create — every QuickBooks row is listed
    // here as unclaimable while any `sync` holder can press the QuickBooks Sync button and have the
    // stale-claim sweep reclaim it, replaying the operation over the settlement.
    //
    // So the real precondition is asked instead, and when it does not hold the row is refused WITH
    // THE REASON AND THE LEVER (describeStillClaimableStrandedRow) rather than silently losing the
    // control — an omitted control with no reason reads as "there is nothing to do here", which is
    // the opposite of the truth for a row the operator can see and cannot clear.
    ...describeSyncRowSettleability(
      unclaimable(row.connector)
        ? { ...row, unclaimable: true }
        : { ...row, unclaimable: false, unclaimableRefusalReason: describeStillClaimableStrandedRow(row.connector) },
    ),
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
 * of this list — but only the settleable ones. A DAILY_BATCH row, or a PENDING row that no sweep
 * reaches, is not clearable from this page at all, and a run of those at the head of the list starves every newer row behind them
 * for as long as they sit there. A bare `take` with no truncation signal would hide that. The extra
 * row is how the UI gets to say so.
 */
export function pageStrandedSyncRows(
  sourceRows: StrandedSyncRowSource[],
  take: number,
  now: Date,
  unclaimable: StrandedRowUnclaimable,
): StrandedSyncRowPage {
  const hasMore = sourceRows.length > take
  return {
    rows: (hasMore ? sourceRows.slice(0, take) : sourceRows).map((row) => describeStrandedSyncRow(row, now, unclaimable)),
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
