import {
  HELD_SALES_INVOICE_RECORD_KIND,
  WC_REFUND_PARK_RECORD_KIND,
} from '@/lib/domain/sales/wc-sync-row-families'

/**
 * ONE PROBE MATRIX FOR THE `shopping_sync_logs` ROW-FAMILY RULES (o3d-272i r3).
 *
 * WHY IT IS SHARED. The rules under test are lib/domain/sales/wc-sync-row-families.ts, whose entire
 * reason to exist is that a predicate stated in more than one place stops meaning one thing. The
 * matrix that DECIDES whether two spellings of that predicate agree had been written out twice —
 * once in tests/domain/sales/wc-sync-row-families.test.ts and once in
 * tests/concurrency/refund-park-index-family-scope.concurrent.test.ts — and the two copies had
 * already drifted: the second carried a `park-no-external` row the first did not, so the unit
 * comparison ran over a strictly weaker set of rows than the database one. A test fixture that
 * drifts is the same defect as a predicate that drifts, one level up.
 *
 * WHAT IT CONTAINS. Thirteen rows: the rows each rule admits, and ONE COUNTER-EXAMPLE PER CLAUSE,
 * each differing from an admitted row in exactly one respect. Dropping any clause from any renderer
 * changes the answer for at least one row here, which is what makes an agreement assertion over it
 * mean something.
 *
 * THE ROW THIS FILE EXISTS TO CARRY IS `unstamped` — `recordKind = NULL`, and otherwise a
 * textbook refund park. It is the row migration 20260822120000's backfill would have stamped, and
 * it is the row that answers UNKNOWN rather than FALSE to any `recordKind = ANY(...)` comparison.
 * Both a positive reader and a NEGATING one have to be asked about it, because SQL gives them
 * different answers unless the predicate is total.
 *
 * EVERY ROW GETS ITS OWN `externalId` (except the one whose absence is the point), because the
 * partial unique index `shopping_sync_logs_active_refund_park_uq` would otherwise refuse the
 * seeding of two actionable parks. The index's own coexistence and collision tests construct their
 * key clashes deliberately and do not use this matrix.
 */
export type WcSyncRowProbe = {
  id: string
  connector: string
  direction: 'FROM_CONNECTOR' | 'TO_CONNECTOR'
  entityType: string
  entityId: string | null
  externalId: string | null
  status: 'PENDING' | 'FAILED' | 'QUARANTINED' | 'SYNCED'
  recordKind: string | null
}

/** The suffixes, in one place, so a test names a row rather than repeating a string. */
export const WC_SYNC_ROW_MATRIX_SUFFIXES = [
  // --- refund parks in the three actionable statuses ----------------------------------------
  'park-pending',
  'park-failed',
  'park-quarantined',
  // --- held sales invoices, the second entityId-bearing family ------------------------------
  'hold-pending',
  'hold-failed',
  // --- one counter-example per clause -------------------------------------------------------
  /** SYNCED is this table's "an operator settled it" terminal. */
  'park-synced',
  /** Names no IMS order — where the pending-FX and admission-refusal queues live. */
  'park-no-entity',
  /** NEVER STAMPED. Admitted by nothing, and — since r3 — excluded by every complement too. */
  'unstamped',
  /** A family that does not exist yet, which is the point of enumerating the ones that do. */
  'other-kind',
  'other-connector',
  'outbound',
  'other-entity-type',
  /** An actionable park with no refund id to be unique per: in the predicate, not in the index. */
  'park-no-external',
] as const

export type WcSyncRowMatrixSuffix = (typeof WC_SYNC_ROW_MATRIX_SUFFIXES)[number]

export function makeWcSyncRowMatrix(probe: string): {
  rowId: (suffix: WcSyncRowMatrixSuffix) => string
  rows: WcSyncRowProbe[]
  ids: string[]
} {
  const rowId = (suffix: WcSyncRowMatrixSuffix) => `${probe}-${suffix}`
  const base: Omit<WcSyncRowProbe, 'id' | 'externalId'> = {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    entityId: `${probe}-order-a`,
    status: 'PENDING',
    recordKind: WC_REFUND_PARK_RECORD_KIND,
  }
  let nextExternalId = 0
  const row = (suffix: WcSyncRowMatrixSuffix, overrides: Partial<WcSyncRowProbe>): WcSyncRowProbe => {
    nextExternalId += 1
    return { ...base, id: rowId(suffix), externalId: `${probe}-e${nextExternalId}`, ...overrides }
  }

  const rows: WcSyncRowProbe[] = [
    row('park-pending', {}),
    row('park-failed', { status: 'FAILED' }),
    row('park-quarantined', { status: 'QUARANTINED' }),
    row('hold-pending', { recordKind: HELD_SALES_INVOICE_RECORD_KIND }),
    row('hold-failed', { recordKind: HELD_SALES_INVOICE_RECORD_KIND, status: 'FAILED' }),
    row('park-synced', { status: 'SYNCED' }),
    row('park-no-entity', { entityId: null }),
    row('unstamped', { recordKind: null }),
    row('other-kind', { recordKind: 'WC_SOMETHING_ELSE' }),
    row('other-connector', { connector: 'shopify' }),
    row('outbound', { direction: 'TO_CONNECTOR' }),
    row('other-entity-type', { entityType: 'Product' }),
    row('park-no-external', { externalId: null }),
  ]

  return { rowId, rows, ids: rows.map((probeRow) => probeRow.id) }
}

/**
 * The rows `unresolvedWcOrderRowWhere()` / `unresolvedWcOrderRowSql()` admit: BOTH
 * entityId-bearing families, in the three actionable statuses. Stated as suffixes so a test asserts
 * membership rather than counting.
 */
export const UNRESOLVED_WC_ORDER_ROW_MATRIX_MEMBERS: WcSyncRowMatrixSuffix[] = [
  'park-pending',
  'park-failed',
  'park-quarantined',
  'hold-pending',
  'hold-failed',
  'park-no-external',
]

/** The rows `activeRefundParkWhere()` admits: the refund-park family only. */
export const ACTIVE_REFUND_PARK_MATRIX_MEMBERS: WcSyncRowMatrixSuffix[] = [
  'park-pending',
  'park-failed',
  'park-quarantined',
  'park-no-external',
]
