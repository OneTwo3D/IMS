/**
 * Daily batch sync — the core of the Xero Sub-Ledger architecture.
 *
 * Execution order: A1 → A2 → B (always in this sequence).
 *
 * Group A1 — Revenue Deferral: DR Sales / CR Unearned Revenue
 *   Any paid order, regardless of stock status (incl. backorders).
 *
 * Group A2 — Inventory Reclassification: DR Allocated / CR Available
 *   Only allocated orders (stock physically reserved).
 *
 * Group B — Shipment: DR Unearned / CR Sales + DR COGS / CR Allocated
 *   Per-shipment, with FIFO cost layer consumption.
 */

import { createHash } from 'node:crypto'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { getXeroSettings } from '@/lib/connectors/xero/settings'
import { normalizeOrderDiscountBase } from '@/lib/sales-currency'
import { Prisma } from '@/app/generated/prisma/client'
import {
  mirrorAccountingSyncLogToEvent,
  resetMirroredAccountingEventsToPending,
} from '@/lib/domain/accounting/accounting-event-mirror'
import { scheduleXeroAccountingOutbox } from '@/lib/connectors/xero/outbox'
import { activeAccountingIdProvenance } from '@/lib/connectors/accounting-id-provenance'
import { stampAccountingPayloadConnection } from '@/lib/connectors/accounting-connection-provenance'
import {
  parseCostLayerSnapshot,
  reduceSnapshotByCostLayer,
  reduceSnapshotByQty,
  sumCostLayerSnapshot,
  takeFromSnapshotEntries,
  unaccountedAllocationQty,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'
import { addMoney, roundQuantity, subtractMoney, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { GL_BASE_PRECISION, roundToGlPrecisionNumber } from '@/lib/domain/math/precision-policy'
import { buildInventoryReconciliationSweepJournal, loadInventoryGlReconciliation } from '@/lib/domain/accounting/inventory-gl-reconciliation'
import { buildCogsReconciliationSweepJournal, loadCogsGlReconciliation } from '@/lib/domain/accounting/cogs-gl-reconciliation'
import { buildTransitReconciliationSweepJournal, loadTransitGlReconciliation } from '@/lib/domain/accounting/transit-gl-reconciliation'
import { recordCogsSubledgerMovement } from '@/lib/domain/accounting/cogs-subledger-movement'
import { recreateJournaledDateFilter } from '@/lib/domain/accounting/daily-batch-retention'
import {
  dailyBatchLiveRefs,
  foldDailyBatchRow,
  type DailyBatchLiveRefs,
  type DailyBatchRecreateBucket,
} from '@/lib/domain/accounting/daily-batch-reference'
import { calculateCoverageByLine } from '@/lib/products/fulfillment-coverage'
import { isFullyShippedTerminalStatus, recognizeShipmentRevenue } from '@/lib/domain/accounting/revenue-recognition'
import {
  sumPostedUnearnedReversal,
  isFullyShippedNetOfRefunds,
  batchContainsFinalUnjournaledShipment,
} from '@/lib/domain/accounting/deferred-trueup'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { lineFulfillmentRequirements } from '@/lib/products/fulfillment-requirement-snapshot'

type MutableLayer = {
  id: string
  remainingQty: number
  unitCostBase: number
}

type LayerSnapshot = Map<string, MutableLayer[]>

type JournalLinePayload = {
  accountCode: string
  description: string
  debit?: number
  credit?: number
}
type AccountingMirrorClient = Pick<Prisma.TransactionClient, 'accountingSyncLog' | 'accountingEvent' | 'accountingEventLog' | 'integrationOutbox' | 'activityLog'>

import { XERO_DAILY_BATCH_LOCK_KEY } from '@/lib/db/advisory-locks'
import { acquirePinnedAdvisoryLockOrNull } from '@/lib/db/pinned-advisory-lock'
const XERO_CONNECTOR = 'xero'
export const XERO_DAILY_BATCH_DEFAULT_LIMIT = 1_000
export const XERO_DAILY_BATCH_MAX_LIMIT = 5_000
const DAILY_BATCH_TYPES = [
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
  'DAILY_BATCH_INVENTORY_RECONCILIATION',
  'DAILY_BATCH_COGS_RECONCILIATION',
  'DAILY_BATCH_TRANSIT_RECONCILIATION',
] as const

// GL postings round to the canonical GL precision (cogs-audit scjz.60); these
// thin aliases keep call sites terse while the precision lives in one place.
function round2(value: number): number {
  return roundToGlPrecisionNumber(value)
}

function round2Decimal(value: Decimal): number {
  return roundQuantity(value, GL_BASE_PRECISION).toNumber()
}

function normalizeDeferredDiscountBase(order: {
  fxRateToBase: Prisma.Decimal | number | null
  discountAmount: Prisma.Decimal | number | null
  pricesIncludeVat: boolean
  taxRatePercent: Prisma.Decimal | number | null
  shoppingLinks?: Array<{ connector: string }>
  lines?: Array<{ totalBase: Prisma.Decimal | number | null; taxRate?: { rate: Prisma.Decimal | number | null } | null }>
}): number {
  return normalizeOrderDiscountBase(order, order.lines)
}

function makeLayerKey(productId: string, warehouseId: string): string {
  return `${productId}|${warehouseId}`
}

export function buildDailyBatchReferenceId(
  group: 'A1' | 'A2' | 'B',
  date: string,
  entityIds: string[],
): string {
  const stableEntityIds = [...entityIds].sort()
  const digest = createHash('sha256')
    .update(stableEntityIds.join('|'))
    .digest('hex')
    .slice(0, 8)
  return `${group}-${date}-${digest}`
}

async function buildLayerSnapshot(
  tx: Prisma.TransactionClient,
  rows: Array<{ productId: string; warehouseId: string }>,
): Promise<LayerSnapshot> {
  const snapshot: LayerSnapshot = new Map()
  const keys = new Set(rows.map((row) => makeLayerKey(row.productId, row.warehouseId)))

  for (const key of keys) {
    const [productId, warehouseId] = key.split('|')
    const candidateLayers = await tx.costLayer.findMany({
      where: {
        productId,
        warehouseId,
        remainingQty: { gt: 0 },
      },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, remainingQty: true, unitCostBase: true },
    })
    if (candidateLayers.length > 0) {
      await tx.$queryRaw`SELECT id FROM cost_layers WHERE id = ANY(${candidateLayers.map((layer) => layer.id)}::text[]) FOR UPDATE`
    }
    const layers = candidateLayers.length === 0
      ? []
      : await tx.costLayer.findMany({
          where: { id: { in: candidateLayers.map((layer) => layer.id) } },
          orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
          select: { id: true, remainingQty: true, unitCostBase: true },
        })
    snapshot.set(
      key,
      layers.map((layer) => ({
        id: layer.id,
        remainingQty: Number(layer.remainingQty),
        unitCostBase: Number(layer.unitCostBase),
      })),
    )
  }

  return snapshot
}

export type A2AllocationRow = {
  id: string
  lineId: string
  productId: string
  warehouseId: string
  qty: Prisma.Decimal | number
  costLayerSnapshot: Prisma.JsonValue | null
}

export type A2ShipmentRow<TLine> = {
  warehouseId: string
  shipmentJournalDate: Date | null
  lines: TLine[]
}

/**
 * WHAT GROUP A2 STILL OWES AN ORDER, ROW BY ROW (o3d-0i5y r5).
 *
 * A2 used to answer that per ORDER: has this order been stamped? On a first pass that is the same
 * question, and while a first pass was the only pass it was harmless. It stopped being the only pass
 * when the journal-safe allocation change let an order that has ALREADY been stamped and part-
 * journaled come back holding MORE allocated quantity than it did then. Per order, the answer for
 * such an order is either "all of it" — re-posting a shipped value the ledger already holds and
 * overwriting the snapshots a journal was posted against — or "none of it", which is what r4 chose
 * and is why the residual never reached the ledger at all. Group B still CREDITS Allocated Inventory
 * when that residual ships, against a debit nothing ever made.
 *
 * Two disjoint things can be owed, and they are SUMMED rather than chosen between:
 *
 *   unjournaledShipments        shipped but not yet journaled, valued from their own line snapshots
 *                               because dispatch has already consumed the layers. A journaled
 *                               shipment is excluded: Group B refuses to journal an unstamped order,
 *                               so a journal date is proof A2 already posted that cost.
 *   outstandingByAllocation     allocated quantity nothing has reclassified, to be valued by pinning
 *                               FIFO layers — but only the outstanding PART of each row, per
 *                               {@link unaccountedAllocationQty}.
 *
 * `stampEmptyAllocationIds` are rows that owe nothing and have never been stamped; they keep the
 * pre-existing empty-snapshot stamp, since their value came through the shipment. Rows that already
 * carry a snapshot appear in NEITHER list and must be left completely alone — that snapshot is the
 * posted evidence Group B and the refund reversal resolve their cost basis through.
 */
export function planA2Reclassification<TLine extends { lineId: string; productId: string | null; qty: Prisma.Decimal | number }, TShipment extends A2ShipmentRow<TLine>>(order: {
  allocations: A2AllocationRow[]
  shipments: TShipment[]
}): {
  unjournaledShipments: TShipment[]
  outstandingByAllocation: Map<string, Decimal>
  stampEmptyAllocationIds: string[]
} {
  const scopeKey = (lineId: string, warehouseId: string, productId: string) => `${lineId}|${warehouseId}|${productId}`
  const shippedQtyByScope = new Map<string, Decimal>()
  for (const shipment of order.shipments) {
    for (const line of shipment.lines) {
      if (!line.productId) continue
      const key = scopeKey(line.lineId, shipment.warehouseId, line.productId)
      shippedQtyByScope.set(key, (shippedQtyByScope.get(key) ?? toDecimal(0)).add(toDecimal(line.qty)))
    }
  }

  const outstandingByAllocation = new Map<string, Decimal>()
  const stampEmptyAllocationIds: string[] = []
  for (const alloc of order.allocations) {
    const outstanding = unaccountedAllocationQty({
      allocatedQty: alloc.qty,
      snapshot: parseCostLayerSnapshot(alloc.costLayerSnapshot),
      shippedQty: shippedQtyByScope.get(scopeKey(alloc.lineId, alloc.warehouseId, alloc.productId)) ?? 0,
    })
    if (outstanding.gt(0)) outstandingByAllocation.set(alloc.id, outstanding)
    else if (alloc.costLayerSnapshot === null) stampEmptyAllocationIds.push(alloc.id)
  }

  return {
    unjournaledShipments: order.shipments.filter((shipment) => !shipment.shipmentJournalDate),
    outstandingByAllocation,
    stampEmptyAllocationIds,
  }
}

function requireShipmentSnapshotValue(order: {
  id: string
  shipments: Array<{
    id: string
    status: string
    lines: Array<{ id: string; qty: Prisma.Decimal | number; costLayerSnapshot: Prisma.JsonValue | null }>
  }>
}): Decimal {
  let total = toDecimal(0)
  let hasShippedLines = false

  for (const shipment of order.shipments) {
    if (shipment.status !== 'SHIPPED') continue
    for (const line of shipment.lines) {
      if (Number(line.qty) <= 0) continue
      hasShippedLines = true
      const snapshot = parseCostLayerSnapshot(line.costLayerSnapshot)
      if (snapshot.length === 0) {
        throw new Error(`Missing FIFO snapshot for already-shipped line ${line.id} on order ${order.id}`)
      }
      total = addMoney(total, sumCostLayerSnapshot(snapshot))
    }
  }

  if (!hasShippedLines) {
    throw new Error(`Order ${order.id} is marked shipped but has no shipped lines to reclassify`)
  }

  return roundQuantity(total, 2)
}

function consumeSnapshotLayers(
  snapshot: LayerSnapshot,
  productId: string,
  warehouseId: string,
  qty: number,
  trackDecrements?: Map<string, number>,
): CostLayerSnapshotEntry[] {
  const layers = snapshot.get(makeLayerKey(productId, warehouseId)) ?? []
  let remaining = qty
  const consumed: CostLayerSnapshotEntry[] = []

  for (const layer of layers) {
    if (remaining <= 0) break
    const take = Math.min(remaining, layer.remainingQty)
    if (take <= 0) continue
    consumed.push({
      costLayerId: layer.id,
      qty: take,
      unitCostBase: layer.unitCostBase,
    })
    layer.remainingQty -= take
    remaining -= take
    if (trackDecrements) {
      trackDecrements.set(layer.id, (trackDecrements.get(layer.id) ?? 0) + take)
    }
  }

  return consumed
}

async function createPendingSyncLog(
  tx: AccountingMirrorClient,
  params: {
    type: 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B' | 'DAILY_BATCH_INVENTORY_RECONCILIATION' | 'DAILY_BATCH_COGS_RECONCILIATION' | 'DAILY_BATCH_TRANSIT_RECONCILIATION'
    referenceId: string
    payload: Record<string, unknown>
    currency: string
  },
): Promise<string> {
  // o3d-19gy: the connection this batch was composed against. A daily-batch journal carries no external
  // document id, but every account code and tax type in it was resolved from the chart of accounts of
  // ONE organisation, so posting it into another is wrong for exactly the same reason.
  //
  // o3d-o97: the return type is the log's OWN id, handed back so A2 can stamp WHICH journal it raised.
  // An identifier cannot exist unless the row was created, and resolving it reads that row's status —
  // which is what stops a queued journal being read as a posted one. The two changes are independent:
  // this stamps whose ledger the batch was composed for, that records which row carries it.
  const payload = stampAccountingPayloadConnection(
    params.payload,
    await activeAccountingIdProvenance(XERO_CONNECTOR),
  )
  const log = await tx.accountingSyncLog.create({
    data: {
      connector: XERO_CONNECTOR,
      type: params.type,
      status: 'PENDING',
      referenceType: 'DailyBatch',
      referenceId: params.referenceId,
      payload: payload as never,
    },
  })
  await scheduleXeroAccountingOutbox(tx, {
    accountingSyncLogId: log.id,
  })
  // Mirror failure must not abort the whole daily batch: the sync log + outbox
  // are already created (and will post), so swallow + warn here exactly as
  // queueAccountingSyncTx does, instead of rolling back every order in the group
  // (cogs-audit scjz.40).
  await mirrorAccountingSyncLogToEvent(tx, {
    syncLogId: log.id,
    connector: XERO_CONNECTOR,
    type: params.type,
    referenceType: 'DailyBatch',
    referenceId: params.referenceId,
    payload: params.payload,
    currency: params.currency,
    status: 'PENDING',
  }).catch((mirrorError: unknown) => tx.activityLog.create({
    data: {
      entityType: 'SYSTEM',
      action: 'accounting_event_mirror_error',
      tag: 'sync',
      level: 'WARNING',
      description: `Daily-batch sync entry ${log.id} was queued but accounting event mirroring failed: ${String(mirrorError)}`,
    },
  }).then(() => undefined))
  // o3d-o97 r3: hand the row's OWN id back. A caller that stamps it on the rows the journal was
  // built from records a value that cannot exist unless this row does — so a stamped amount can no
  // longer merely imply a journal, and the row's status can be read back to ask whether it posted.
  return log.id
}

async function lockCostLayers(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "cost_layers" WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`,
  )
}

async function resetFailedDailyBatchLogs(): Promise<void> {
  await db.$transaction(async (tx) => {
    const failedLogs = await tx.accountingSyncLog.findMany({
      where: {
        connector: XERO_CONNECTOR,
        type: { in: [...DAILY_BATCH_TYPES] },
        status: 'FAILED',
      },
      select: { referenceId: true },
    })

    await tx.accountingSyncLog.updateMany({
      where: {
        connector: XERO_CONNECTOR,
        type: { in: [...DAILY_BATCH_TYPES] },
        status: 'FAILED',
      },
      data: {
        status: 'PENDING',
        retryCount: 0,
        errorMessage: null,
        processingStartedAt: null,
      },
    })

    await resetMirroredAccountingEventsToPending(tx, {
      connector: XERO_CONNECTOR,
      types: [...DAILY_BATCH_TYPES],
      referenceType: 'DailyBatch',
      referenceIds: failedLogs.map((log) => log.referenceId),
    })
  })
}

type DailyBatchLogType = typeof DAILY_BATCH_TYPES[number]
type DailyBatchGroup = 'groupA1' | 'groupA2' | 'groupB'

export type XeroDailyBatchResult = {
  groupA1: number
  groupA2: number
  groupB: number
  batchLimit: number
  hasMore: Record<DailyBatchGroup, boolean>
  errors: string[]
  // cogs-audit scjz.60.4: the rounding-residue (GL_BASE_PRECISION units) swept to the
  // rounding-difference account this run, or null when nothing was swept (balanced,
  // unavailable, material gap flagged, or no rounding account configured).
  inventoryReconciliationSwept?: number | null
  // khdw: same, for the COGS subledger-vs-GL rounding sweep.
  cogsReconciliationSwept?: number | null
  // 6oyu.4 (khdw): same, for the STOCK_IN_TRANSIT subledger-vs-GL rounding sweep.
  transitReconciliationSwept?: number | null
}

export function resolveXeroDailyBatchLimit(value = process.env.XERO_DAILY_BATCH_LIMIT): number {
  if (value === undefined || value.trim() === '') return XERO_DAILY_BATCH_DEFAULT_LIMIT
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return XERO_DAILY_BATCH_DEFAULT_LIMIT
  return Math.min(Math.floor(parsed), XERO_DAILY_BATCH_MAX_LIMIT)
}

export function takeDailyBatchWindow<T>(
  rows: T[],
  limit: number,
): { rows: T[]; hasMore: boolean } {
  if (rows.length <= limit) return { rows, hasMore: false }
  return {
    rows: rows.slice(0, limit),
    hasMore: true,
  }
}

/** In the outbox or in the ledger: a log in any of these states blocks a recreate outright. */
const LIVE_DAILY_BATCH_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED'] as const

/**
 * o3d-o97 r6 — MAY THIS BATCH BE POSTED AGAIN? AND THE ANSWER IS NEVER A STATUS.
 *
 * This probe is the ONLY thing standing between the recreate sweep and a DUPLICATE journal in a
 * real ledger, and until r6 it asked "is a log for this batch still live?", where live meant
 * `status in (PENDING, PROCESSING, SYNCED)`. Everything else — CANCELLED above all — read as "no
 * log, so the journal never posted, so post it again".
 *
 * That is the exact inference r5 spent the rest of this branch dismantling, inverted. r5 made
 * CANCELLED stop being proof that a debit DID NOT post (`allocated-inventory-debit.ts`,
 * `proveJournalPosting` in refund-service.ts): it means SOMEBODY OR SOMETHING ABANDONED THE ROW —
 * a sweep, an order cancellation, an operator — and none of them can see whether the remote call
 * had already landed, because the processors POST BEFORE they persist SYNCED and the external id.
 * The same status was still proof to THIS reader that the batch must be posted again. Two readers,
 * opposite conclusions, one fact; and this is the reader that writes to the ledger.
 *
 * WORKED. Group A2 stages 30 orders into journal J for £4,120 and J reaches Xero. J is later marked
 * CANCELLED — by the cross-connector orphan sweep during a connector switch, or by an operator
 * tidying the sync screen. The next daily run sweeps: the 30 orders still carry
 * `inventoryAllocatedDate`, J is not "live", so a SECOND £4,120 DR Allocated Inventory / CR
 * Inventory is queued and posts. Allocated Inventory now holds £8,240 for £4,120 of allocations,
 * and each order's `allocationBatchAmount` records one £-share, so the eventual refunds can only
 * ever reverse half of it. r5 made this MORE reachable, not less: it stopped the un-stage sites
 * clearing the stamp on a cancelled journal, so those 30 orders now stay in this sweep's candidate
 * set instead of leaving it.
 *
 * SO THE QUESTION IS ASKED THE SAME WAY IT IS ASKED EVERYWHERE ELSE IN o3d-o97 — only POSITIVE
 * EVIDENCE moves money — and there are exactly three answers:
 *
 *   BLOCKED, live       a row in PENDING/PROCESSING/SYNCED. Unchanged: the journal is in the outbox
 *                       or in the ledger.
 *   BLOCKED, unproved   a row that is neither live nor provably pre-call — CANCELLED, FAILED, a row
 *                       cancelled before this column existed. It may already be in the ledger, so
 *                       re-raising it is a coin flip that costs a duplicate journal when it loses.
 *                       Nothing is posted and the batch is REPORTED on the run's errors, so the
 *                       refusal is visible instead of being a silent skip. (FAILED rows are already
 *                       reset to PENDING by `resetFailedDailyBatchLogs` before this runs, so in
 *                       practice this is the cancelled set.)
 *   ALLOWED             no row at all — which, INSIDE the retention window this sweep is bounded to
 *                       (scjz.36), means the log genuinely went missing before it posted — or every
 *                       row for the batch carries `abandonedBeforeRemoteCall`, the orphan sweep's
 *                       own record that it cancelled a PENDING row and nothing was ever sent.
 *
 * A row bearing an `externalTransactionId` blocks whatever its status says: that id exists only
 * because the remote call returned, so it is the ledger's own receipt and outranks any later
 * abandonment written over the top of it.
 *
 * `refs` is either a single derived `<group>-<date>` key (the reconciliation sweeps, whose identity
 * is `<PREFIX>-<date>` by construction and never persisted) or a bucket's full set of candidate
 * referenceIds. Every candidate is ORed together, and a bucket with NO candidates at all is blocked
 * rather than recreated blind.
 */
type DailyBatchRecreateVerdict = { blocked: boolean; refusal: string | null }

async function dailyBatchRecreateVerdict(
  type: DailyBatchLogType,
  refs: string | DailyBatchLiveRefs,
): Promise<DailyBatchRecreateVerdict> {
  const { exact, derived } = typeof refs === 'string' ? { exact: [], derived: [refs] } : refs
  const alternatives: Prisma.AccountingSyncLogWhereInput[] = []
  // The exact persisted referenceId of the batch this row was staged into — the only
  // candidate that survives a run crossing UTC midnight (o3d-0qoo).
  for (const referenceId of exact) alternatives.push({ referenceId })
  // The live daily-batch posting stamps a digest-suffixed referenceId
  // (buildDailyBatchReferenceId -> `<group>-<date>-<8 hex>`), so an exact match on
  // the bare `<group>-<date>` never finds it and recreate would post a duplicate
  // batch (double-post). Match the bare key OR any digest-suffixed variant for the
  // same group+date (scjz.37). Kept ALONGSIDE the persisted refs, never replaced by
  // them: this probe must never see fewer logs than it did before the column.
  for (const bareReferenceId of derived) {
    alternatives.push(
      { referenceId: bareReferenceId },
      { referenceId: { startsWith: `${bareReferenceId}-` } },
    )
  }
  if (alternatives.length === 0) return { blocked: true, refusal: null }
  // NO STATUS PREDICATE. The rows are read and judged here, because "which rows exist" and "what
  // they prove" are two different questions and the old query answered the second one in the WHERE
  // clause, where a cancelled row simply vanished.
  const rows = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      type,
      OR: alternatives,
    },
    select: { id: true, referenceId: true, status: true, externalTransactionId: true, abandonedBeforeRemoteCall: true },
  })
  if (rows.length === 0) return { blocked: false, refusal: null }
  if (rows.some((row) => LIVE_DAILY_BATCH_STATUSES.includes(row.status as typeof LIVE_DAILY_BATCH_STATUSES[number]))) {
    return { blocked: true, refusal: null }
  }
  const unproved = rows.filter((row) => row.abandonedBeforeRemoteCall !== true || row.externalTransactionId)
  if (unproved.length === 0) return { blocked: false, refusal: null }
  const describe = unproved
    .map((row) => `${row.referenceId} (${row.id}, ${row.status}${row.externalTransactionId ? `, external id ${row.externalTransactionId}` : ''})`)
    .join(', ')
  return {
    blocked: true,
    refusal:
      `Daily batch ${type} not recreated: ${describe} — ` +
      'a cancelled or failed row does not establish that its journal never reached the ledger ' +
      '(the processor posts before it persists SYNCED), so re-raising it could post the same ' +
      'journal twice. Re-post it deliberately, or leave it: the orders/shipments keep their stamps ' +
      'and the standing accounting invariants keep reporting them.',
  }
}


/**
 * Rebuild daily-batch logs that went missing before they posted.
 *
 * o3d-0qoo: rows are bucketed by the referenceId the daily sync PERSISTED on them, not by
 * a key re-derived from their stage stamp. A run crossing UTC midnight stamps the row on
 * the day AFTER its batch's own date, so the derived key names a batch that never existed
 * — the sweep found no live log for it and re-posted a journal that was already in the
 * ledger. The persisted reference is the batch's real identity, so it is what the sweep
 * probes for, recreates under, and dates the journal from. Rows staged before that column
 * existed have no persisted ref and keep the old derived-key behaviour exactly.
 *
 * o3d-o97 r6: returns the batches it REFUSED to rebuild — a cancelled log is not evidence that its
 * journal never posted, so the sweep leaves it alone and the caller surfaces it on the run instead
 * of skipping silently. See `dailyBatchRecreateVerdict`.
 */
export async function recreateMissingDailyBatchLogs(settings: Awaited<ReturnType<typeof getXeroSettings>>, baseCurrency: string): Promise<string[]> {
  const refusals: string[] = []
  // scjz.36: only recreate within the sync-log retention window — beyond it, SYNCED
  // daily-batch logs are pruned by data-retention, so a "missing" log can't be told
  // apart from one that already posted, and rebuilding would double-post the journal.
  const journaledDateFilter = await recreateJournaledDateFilter()
  const orphanA1Orders = await db.salesOrder.findMany({
    where: { revenueDeferredDate: journaledDateFilter },
    select: { revenueDeferredDate: true, revenueDeferredBatchRef: true, unearnedRevenueAmount: true },
  })
  const orphanA2Orders = await db.salesOrder.findMany({
    where: {
      inventoryAllocatedDate: journaledDateFilter,
      // o3d-o97 r3: NEVER rebuild an A2 journal for a fully-refunded order. Group A2's own window
      // excludes `refundStatus: FULL` permanently, and so does Group B, so a debit re-posted here
      // has nothing left in IMS that will ever relieve it. The case is now reachable: a refund
      // that CANNOT account for the A2 debit deliberately keeps the order's A2 stamp so the
      // standing invariants stay able to report it (see refund-service.ts) — so without this filter
      // the very orders held open for a human to resolve would be candidates for a fresh,
      // permanently unrelievable debit. (o3d-o97 r6 closed the other half of that: a CANCELLED log
      // no longer reads as "no journal" and no longer licenses a rebuild on its own.)
      refundStatus: { not: 'FULL' },
    },
    select: { inventoryAllocatedDate: true, inventoryAllocatedBatchRef: true, allocationBatchAmount: true },
  })
  const orphanBShipments = await db.shipment.findMany({
    where: { shipmentJournalDate: journaledDateFilter },
    select: { id: true, shipmentJournalDate: true, shipmentJournalBatchRef: true, revenueRecognizedAmount: true, cogsBatchAmount: true },
  })

  const a1Batches = new Map<string, DailyBatchRecreateBucket<{ orderCount: number; total: number }>>()
  for (const order of orphanA1Orders) {
    const summary = foldDailyBatchRow(
      a1Batches,
      'A1',
      { stagedAt: order.revenueDeferredDate, persistedRef: order.revenueDeferredBatchRef },
      () => ({ orderCount: 0, total: 0 }),
    )
    if (!summary) continue
    summary.orderCount += 1
    summary.total += Number(order.unearnedRevenueAmount ?? 0)
  }

  const a2Batches = new Map<string, DailyBatchRecreateBucket<{ orderCount: number; total: number }>>()
  for (const order of orphanA2Orders) {
    const summary = foldDailyBatchRow(
      a2Batches,
      'A2',
      { stagedAt: order.inventoryAllocatedDate, persistedRef: order.inventoryAllocatedBatchRef },
      () => ({ orderCount: 0, total: 0 }),
    )
    if (!summary) continue
    summary.orderCount += 1
    summary.total += Number(order.allocationBatchAmount ?? 0)
  }

  const bBatches = new Map<string, DailyBatchRecreateBucket<{ shipmentCount: number; revenue: number; cogs: number; shipments: Array<{ id: string; cogs: number }> }>>()
  for (const shipment of orphanBShipments) {
    const summary = foldDailyBatchRow(
      bBatches,
      'B',
      { stagedAt: shipment.shipmentJournalDate, persistedRef: shipment.shipmentJournalBatchRef },
      () => ({ shipmentCount: 0, revenue: 0, cogs: 0, shipments: [] }),
    )
    if (!summary) continue
    const shipmentCogs = Number(shipment.cogsBatchAmount ?? 0)
    summary.shipmentCount += 1
    summary.revenue += Number(shipment.revenueRecognizedAmount ?? 0)
    summary.cogs += shipmentCogs
    // bcz9.3: carry the per-shipment list so the recreate path can write the same
    // per-shipment DISPATCH ledger rows the live dispatch path writes.
    summary.shipments.push({ id: shipment.id, cogs: shipmentCogs })
  }

  for (const { referenceId, date, summary, ...batch } of a1Batches.values()) {
    if (summary.total <= 0) continue
    const verdict = await dailyBatchRecreateVerdict('DAILY_BATCH_REVENUE_DEFERRAL', dailyBatchLiveRefs(batch))
    if (verdict.blocked) {
      if (verdict.refusal) refusals.push(verdict.refusal)
      continue
    }
    await db.$transaction(async (tx) => {
      await createPendingSyncLog(tx, {
        type: 'DAILY_BATCH_REVENUE_DEFERRAL',
        referenceId,
        currency: baseCurrency,
        payload: {
          date,
          reference: `Revenue Deferral ${date}`,
          narration: `Recreated revenue deferral batch: ${summary.orderCount} order(s), £${round2(summary.total).toFixed(2)}`,
          lines: [
            { accountCode: settings.xero_sales_account, description: `Daily revenue deferral — ${summary.orderCount} order(s)`, debit: round2(summary.total) },
            { accountCode: settings.xero_unearned_revenue_account, description: `Daily revenue deferral — ${summary.orderCount} order(s)`, credit: round2(summary.total) },
          ],
          _postingMode: 'submitted',
          _recreatedFromStage: true,
        },
      })
    })
  }

  for (const { referenceId, date, summary, ...batch } of a2Batches.values()) {
    if (summary.total <= 0) continue
    const verdict = await dailyBatchRecreateVerdict('DAILY_BATCH_INVENTORY_ALLOC', dailyBatchLiveRefs(batch))
    if (verdict.blocked) {
      if (verdict.refusal) refusals.push(verdict.refusal)
      continue
    }
    await db.$transaction(async (tx) => {
      await createPendingSyncLog(tx, {
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        referenceId,
        currency: baseCurrency,
        payload: {
          date,
          reference: `Inventory Allocation ${date}`,
          narration: `Recreated inventory allocation batch: ${summary.orderCount} order(s), £${round2(summary.total).toFixed(2)}`,
          lines: [
            { accountCode: settings.xero_allocated_inventory_account, description: `Daily inventory allocation — ${summary.orderCount} order(s)`, debit: round2(summary.total) },
            { accountCode: settings.xero_inventory_account, description: `Daily inventory allocation — ${summary.orderCount} order(s)`, credit: round2(summary.total) },
          ],
          _postingMode: 'submitted',
          _recreatedFromStage: true,
        },
      })
    })
  }

  for (const { referenceId, date, summary, ...batch } of bBatches.values()) {
    if (summary.revenue <= 0 && summary.cogs <= 0) continue
    const verdict = await dailyBatchRecreateVerdict('DAILY_BATCH_GROUP_B', dailyBatchLiveRefs(batch))
    if (verdict.blocked) {
      if (verdict.refusal) refusals.push(verdict.refusal)
      continue
    }
    const lines: JournalLinePayload[] = []
    if (round2(summary.revenue) > 0) {
      lines.push(
        { accountCode: settings.xero_unearned_revenue_account, description: `Revenue recognition — ${summary.shipmentCount} shipment(s)`, debit: round2(summary.revenue) },
        { accountCode: settings.xero_sales_account, description: `Revenue recognition — ${summary.shipmentCount} shipment(s)`, credit: round2(summary.revenue) },
      )
    }
    if (round2(summary.cogs) > 0) {
      lines.push(
        { accountCode: settings.xero_cogs_account, description: `COGS — ${summary.shipmentCount} shipment(s)`, debit: round2(summary.cogs) },
        { accountCode: settings.xero_allocated_inventory_account, description: `COGS — ${summary.shipmentCount} shipment(s)`, credit: round2(summary.cogs) },
      )
    }
    await db.$transaction(async (tx) => {
      await createPendingSyncLog(tx, {
        type: 'DAILY_BATCH_GROUP_B',
        referenceId,
        currency: baseCurrency,
        payload: {
          date,
          reference: `Shipment COGS ${date}`,
          narration: `Recreated shipment batch: ${summary.shipmentCount} shipment(s), revenue £${round2(summary.revenue).toFixed(2)}, COGS £${round2(summary.cogs).toFixed(2)}`,
          lines,
          _postingMode: 'submitted',
          _recreatedFromStage: true,
        },
      })
      // bcz9.3: the recreated Group B journal moves GL COGS, so write the same
      // per-shipment DISPATCH ledger rows the live dispatch path writes, dated to the
      // recreated journal date — the BATCH's own date, from its persisted reference, so a
      // midnight-crossing run does not date the subledger a day after its GL journal
      // (o3d-0qoo) — and keyed identically (dispatch:<shipmentId>). The key
      // is idempotent: where a live dispatch row already exists (the common case) this
      // is a no-op preserving the original value; where a shipment never got one it
      // fills the gap so the COGS reconciliation ties out instead of perpetually flagging.
      for (const shipment of summary.shipments) {
        await recordCogsSubledgerMovement(tx, {
          sourceType: 'DISPATCH',
          sourceRef: shipment.id,
          idempotencyKey: `dispatch:${shipment.id}`,
          baseDelta: shipment.cogs,
          journalDate: date,
        })
      }
    })
  }

  return refusals
}

export async function runDailyBatchSync(): Promise<XeroDailyBatchResult> {
  const batchLimit = resolveXeroDailyBatchLimit()
  const result: XeroDailyBatchResult = {
    groupA1: 0,
    groupA2: 0,
    groupB: 0,
    batchLimit,
    hasMore: { groupA1: false, groupA2: false, groupB: false },
    errors: [],
  }
  // o3d-4ajo: pinned to ONE connection. Taking this through Prisma and releasing
  // it through Prisma can hit different pooled sockets, so the unlock silently
  // no-ops and the lock leaks — and this key is shared with refund creation /
  // the Xero payment jobs, so a leak stalls those too, not just the batch.
  const batchLock = await acquirePinnedAdvisoryLockOrNull(XERO_DAILY_BATCH_LOCK_KEY)
  if (!batchLock) {
    result.errors.push('Daily batch already running')
    return result
  }

  try {
    const settings = await getXeroSettings()
    const baseCurrency = await getBaseCurrencyCode()
    const today = new Date().toISOString().slice(0, 10)


    if (settings.xero_sync_enabled !== 'true') {
      return result
    }

    await resetFailedDailyBatchLogs()
    // o3d-o97 r6: a batch the sweep REFUSED to rebuild (its only log is cancelled, which does not
    // establish that the journal never reached the ledger) is reported on the run rather than
    // skipped silently — it is the one outcome where a human has to decide whether to re-post.
    result.errors.push(...await recreateMissingDailyBatchLogs(settings, baseCurrency))

  // --- Group A1: Revenue Deferral ---
  try {
    // o3d-4ajo: Postgres frees a session lock the instant its connection dies,
    // so from that moment another batch — or a refund, which shares this domain
    // — can start while we are still writing. Stop instead.
    batchLock.assertHeld('Group A1 (revenue deferral)')
    const orderWindow = takeDailyBatchWindow(await db.salesOrder.findMany({
      where: {
        paidAt: { not: null },
        revenueDeferredDate: null,
        accountingInvoiceId: { not: null },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
        refundStatus: { not: 'FULL' },
      },
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        fxRateToBase: true,
        subtotalBase: true,
        shippingBase: true,
        discountAmount: true,
        pricesIncludeVat: true,
        taxRatePercent: true,
        shoppingLinks: {
          select: { connector: true },
        },
        lines: {
          select: {
            totalBase: true,
            taxRate: { select: { rate: true } },
          },
        },
      },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      take: batchLimit + 1,
    }), batchLimit)
    const orders = orderWindow.rows
    result.hasMore.groupA1 = orderWindow.hasMore

    if (orders.length > 0) {
      const orderDeferrals = orders.map((order) => {
        const discountBase = normalizeDeferredDiscountBase(order)
        return {
          orderId: order.id,
          amount: round2(Number(order.subtotalBase) + Number(order.shippingBase ?? 0) - discountBase),
        }
      })
      let totalRevenueDeferred = 0
      const journalLines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = []

      for (const orderDeferral of orderDeferrals) totalRevenueDeferred += orderDeferral.amount

      totalRevenueDeferred = round2(totalRevenueDeferred)
      const invariantTotal = round2(orderDeferrals.reduce((sum, order) => sum + order.amount, 0))
      if (Math.abs(invariantTotal - totalRevenueDeferred) > 0.01) {
        throw new Error(`A1 revenue deferral invariant failed: per-order ${invariantTotal.toFixed(2)} != journal ${totalRevenueDeferred.toFixed(2)}`)
      }

      if (totalRevenueDeferred > 0) {
        journalLines.push(
          { accountCode: settings.xero_sales_account, description: `Daily revenue deferral — ${orders.length} order(s)`, debit: totalRevenueDeferred },
          { accountCode: settings.xero_unearned_revenue_account, description: `Daily revenue deferral — ${orders.length} order(s)`, credit: totalRevenueDeferred },
        )
      }

      // o3d-0qoo: computed ONCE, here, and stamped onto every member order inside the same
      // transaction as the stage stamp. It is deliberately NOT re-derived per order from
      // revenueDeferredDate: `today` is captured at run start while the stamps are written
      // with later new Date() calls, so a run crossing UTC midnight makes the two disagree
      // and every consumer that re-derives looks for a batch that does not exist.
      const referenceId = buildDailyBatchReferenceId('A1', today, orders.map((order) => order.id))

      await db.$transaction(async (tx) => {
        if (journalLines.length > 0) {
          await createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_REVENUE_DEFERRAL',
            referenceId,
            currency: baseCurrency,
            payload: {
              date: today,
              reference: `Revenue Deferral ${today} ${referenceId.slice(-8)}`,
              narration: `Daily revenue deferral: ${orders.length} order(s), £${totalRevenueDeferred.toFixed(2)}`,
              lines: journalLines,
              orderDeferrals,
              batchReferenceId: referenceId,
              batchDate: today,
              batchGroup: 'A1',
              batchEntityCount: orders.length,
              splitBatch: result.hasMore.groupA1,
              _postingMode: 'submitted',
            },
          })
        }

        const deferralByOrderId = new Map(orderDeferrals.map((order) => [order.orderId, order.amount]))
        for (const order of orders) {
          await tx.salesOrder.update({
            where: { id: order.id },
            data: {
              revenueDeferredDate: new Date(),
              revenueDeferredBatchRef: referenceId,
              unearnedRevenueAmount: deferralByOrderId.get(order.id) ?? 0,
            },
          })
        }
      })

      result.groupA1 = orders.length
    }
  } catch (e) {
    result.errors.push(`Group A1 error: ${String(e)}`)
  }

  // --- Group A2: Inventory Reclassification ---
  try {
    // o3d-4ajo: Postgres frees a session lock the instant its connection dies,
    // so from that moment another batch — or a refund, which shares this domain
    // — can start while we are still writing. Stop instead.
    batchLock.assertHeld('Group A2 (inventory reclassification)')
    const orderWindow = takeDailyBatchWindow(await db.salesOrder.findMany({
      where: {
        revenueDeferredDate: { not: null },
        inventoryAllocatedDate: null,
        status: { in: ['ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED'] },
        refundStatus: { not: 'FULL' },
      },
      orderBy: [{ revenueDeferredDate: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        status: true,
        allocations: {
          select: {
            id: true,
            lineId: true,
            productId: true,
            warehouseId: true,
            qty: true,
            // o3d-0i5y r5: what THIS row has already had reclassified. Without it A2 can only ask an
            // order-level question, and the residual added to a part-journaled order is invisible.
            costLayerSnapshot: true,
          },
        },
        shipments: {
          where: { status: 'SHIPPED' },
          select: {
            id: true,
            status: true,
            warehouseId: true,
            // A shipment Group B has already journaled had its cost reclassified by the A2 run that
            // stamped this order the first time — B refuses to journal an unstamped order — so its
            // value must NOT be posted again when the order comes back for its residual.
            shipmentJournalDate: true,
            lines: {
              select: {
                id: true,
                lineId: true,
                productId: true,
                qty: true,
                costLayerSnapshot: true,
              },
            },
          },
        },
      },
      take: batchLimit + 1,
    }), batchLimit)
    const orders = orderWindow.rows
    result.hasMore.groupA2 = orderWindow.hasMore

    if (orders.length > 0) {
      // o3d-0qoo: batch identity, computed once from the run-start date and this batch's own
      // order set, then persisted on every member row alongside its stage stamp. See the A1
      // note above for why deriving it back from inventoryAllocatedDate is not equivalent.
      const referenceId = buildDailyBatchReferenceId('A2', today, orders.map((order) => order.id))

      await db.$transaction(async (tx) => {
        let totalAllocatedValue = toDecimal(0)
        const plans = new Map(orders.map((order) => [order.id, planA2Reclassification(order)]))

        const snapshot = await buildLayerSnapshot(
          tx,
          orders.flatMap((order) => {
            const plan = plans.get(order.id)!
            return order.allocations
              .filter((alloc) => plan.outstandingByAllocation.has(alloc.id))
              .map((alloc) => ({
                productId: alloc.productId,
                warehouseId: alloc.warehouseId,
              }))
          }),
        )
        const orderValues = new Map<string, number>()
        const allocationSnapshots = new Map<string, CostLayerSnapshotEntry[]>()

        for (const order of orders) {
          const plan = plans.get(order.id)!
          let orderCostValue = plan.unjournaledShipments.length > 0
            ? requireShipmentSnapshotValue({ ...order, shipments: plan.unjournaledShipments })
            : toDecimal(0)

          // Rows that have never been reclassified at all but owe nothing are still STAMPED with an
          // empty snapshot, exactly as before — their cost came from the shipment snapshots above.
          for (const allocationId of plan.stampEmptyAllocationIds) allocationSnapshots.set(allocationId, [])

          for (const alloc of order.allocations) {
            const outstanding = plan.outstandingByAllocation.get(alloc.id)
            if (!outstanding) continue
            const consumed = consumeSnapshotLayers(
              snapshot,
              alloc.productId,
              alloc.warehouseId,
              outstanding.toNumber(),
            )
            // APPENDED, not replaced, so `snapshotQty` keeps naming everything ever posted against
            // this row — which is what makes the next pass's outstanding calculation right.
            allocationSnapshots.set(alloc.id, [...parseCostLayerSnapshot(alloc.costLayerSnapshot), ...consumed])
            orderCostValue = addMoney(orderCostValue, sumCostLayerSnapshot(consumed))
          }
          orderCostValue = roundQuantity(orderCostValue, 2)

          totalAllocatedValue = addMoney(totalAllocatedValue, orderCostValue)
          orderValues.set(order.id, orderCostValue.toNumber())
        }

        const totalAllocatedValueNumber = round2Decimal(totalAllocatedValue)
        // o3d-o97 r3: null when NO journal was raised. The guard below is on the batch's ROUNDED
        // total, so a window whose only member values at £0.004 stamps that order with an amount
        // and creates no journal at all — which is exactly the inference ("an amount implies a
        // pass that created a journal") the refund reversal used to rest on.
        let a2SyncLogId: string | null = null
        if (totalAllocatedValueNumber > 0) {
          a2SyncLogId = await createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_INVENTORY_ALLOC',
            referenceId,
            currency: baseCurrency,
            payload: {
              date: today,
              reference: `Inventory Allocation ${today} ${referenceId.slice(-8)}`,
              narration: `Daily inventory reclassification: ${orders.length} order(s), £${totalAllocatedValueNumber.toFixed(2)}`,
              lines: [
                { accountCode: settings.xero_allocated_inventory_account, description: `Daily inventory allocation — ${orders.length} order(s)`, debit: totalAllocatedValueNumber },
                { accountCode: settings.xero_inventory_account, description: `Daily inventory allocation — ${orders.length} order(s)`, credit: totalAllocatedValueNumber },
              ],
              batchReferenceId: referenceId,
              batchDate: today,
              batchGroup: 'A2',
              batchEntityCount: orders.length,
              splitBatch: result.hasMore.groupA2,
              _postingMode: 'submitted',
            },
          })
        }

        for (const order of orders) {
          for (const alloc of order.allocations) {
            const next = allocationSnapshots.get(alloc.id)
            // `undefined` means "this row was already accounted and is not being changed". It is NOT
            // the same as `[]`, which is a deliberate stamp; writing `?? []` here would erase the
            // pinned layers of every row a previous pass posted (o3d-0i5y r5).
            if (!next) continue
            const priorPosted = parseCostLayerSnapshot(alloc.costLayerSnapshot)
            await tx.orderAllocation.update({
              where: { id: alloc.id },
              data: {
                costLayerSnapshot: next as never,
                // o3d-o97 r3: the pounds this row contributed to the DR above, pinned beside the
                // layers it was pinned from. Revaluation rewrites those layers' unitCostBase in
                // the snapshot; it never posts to Allocated Inventory, so this figure is what a
                // refund of part of this row has to reverse at.
                //
                // o3d-0i5y r5 (rebase): `next` is the APPENDED snapshot, so this is the total ever
                // posted against the row rather than one pass's share — which is the figure a
                // partial refund of the row needs, and it stays in step with `snapshotQty`.
                // And where THIS pass raised no journal, an EARLIER pass's record is left alone
                // rather than nulled: `undefined` is "do not update", while `null` would erase a
                // debit that is still standing and is the evidence-deletion o3d-o97 r4 refused.
                allocationBatchAmount: a2SyncLogId
                  ? roundQuantity(sumCostLayerSnapshot(next), 4).toNumber()
                  : priorPosted.length > 0 ? undefined : null,
              },
            })
          }
          await tx.salesOrder.update({
            where: { id: order.id },
            data: {
              inventoryAllocatedDate: new Date(),
              inventoryAllocatedBatchRef: referenceId,
              allocationBatchAmount: orderValues.get(order.id) ?? 0,
              // o3d-o97 r3: the journal's identity and DESTINATION, recorded with the amount it
              // carried. All three stay null when no journal was raised, so a refund reading them
              // back can tell "A2 debited £x on ledger L, account A" from "A2 valued this order at
              // £x and posted nothing".
              allocationBatchSyncLogId: a2SyncLogId,
              allocationBatchConnector: a2SyncLogId ? XERO_CONNECTOR : null,
              allocationBatchAccountCode: a2SyncLogId ? settings.xero_allocated_inventory_account : null,
            },
          })
        }
      })

      result.groupA2 = orders.length
    }
  } catch (e) {
    result.errors.push(`Group A2 error: ${String(e)}`)
  }

  // --- Group B: Shipment Revenue Recognition + COGS ---
  try {
    // o3d-4ajo: Postgres frees a session lock the instant its connection dies,
    // so from that moment another batch — or a refund, which shares this domain
    // — can start while we are still writing. Stop instead.
    batchLock.assertHeld('Group B (shipment revenue + COGS)')
    const groupBCount = await db.$transaction(async (tx) => {
      const shipmentWindow = takeDailyBatchWindow(await tx.shipment.findMany({
        where: {
          status: 'SHIPPED',
          shipmentJournalDate: null,
          order: {
            refundStatus: { not: 'FULL' },
            revenueDeferredDate: { not: null },
            inventoryAllocatedDate: { not: null },
          },
        },
        select: {
          id: true,
          orderId: true,
          warehouseId: true,
          createdAt: true,
          cogsBatchAmount: true,
          lines: {
            select: {
              id: true,
              lineId: true,
              productId: true,
              qty: true,
              costLayerSnapshot: true,
              line: {
                select: { id: true, productId: true, qty: true, totalBase: true },
              },
            },
          },
          order: {
            select: {
              orderNumber: true,
              externalOrderNumber: true,
              status: true,
              refundStatus: true,
              totalBase: true,
              unearnedRevenueAmount: true,
              lines: {
                select: {
                  id: true,
                  productId: true,
                  qty: true,
                  totalBase: true,
                  // o3d-kouj: the recipe this line was allocated from. Group B's per-line component
                  // requirements decide which shipped component units belong to which sales line, and
                  // the basis it relieves was recorded in exactly those units at dispatch.
                  fulfillmentRequirements: true,
                },
              },
              shipments: {
                select: {
                  id: true,
                  status: true,
                  shipmentJournalDate: true,
                  revenueRecognizedAmount: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: batchLimit + 1,
      }), batchLimit)
      const shipments = shipmentWindow.rows
      result.hasMore.groupB = shipmentWindow.hasMore

      if (shipments.length === 0) {
        return 0
      }

      let totalRevenue = 0
      let totalCogs = toDecimal(0)
      const layerDecrements = new Map<string, number>()
      const shipmentResults = new Map<string, { revenue: number; cogs: number }>()
      const shipmentSnapshots = new Map<string, CostLayerSnapshotEntry[]>()
      const shipmentsByOrder = new Map<string, typeof shipments>()
      const orderIds = Array.from(new Set(shipments.map((shipment) => shipment.orderId)))

      const [orderAllocations, priorShipmentLines, priorRefundLines] = await Promise.all([
        tx.orderAllocation.findMany({
          where: { orderId: { in: orderIds } },
          select: {
            id: true,
            orderId: true,
            lineId: true,
            productId: true,
            warehouseId: true,
            costLayerSnapshot: true,
          },
        }),
        tx.shipmentLine.findMany({
          where: {
            shipment: {
              orderId: { in: orderIds },
              shipmentJournalDate: { not: null },
            },
          },
          select: {
            costLayerSnapshot: true,
          },
        }),
        tx.salesOrderRefundLine.findMany({
          where: {
            refund: {
              orderId: { in: orderIds },
            },
          },
          select: {
            costLayerSnapshot: true,
          },
        }),
      ])

      const referencedCostLayerIds = Array.from(new Set(
        orderAllocations.flatMap((allocation) => (
          parseCostLayerSnapshot(allocation.costLayerSnapshot).map((entry) => entry.costLayerId)
        )),
      ))
      await lockCostLayers(tx, referencedCostLayerIds)
      const graph = await loadFulfillmentProductGraph(
        tx,
        Array.from(new Set(
          shipments.flatMap((shipment) => (
            shipment.order.lines.map((line) => line.productId).filter((value): value is string => !!value)
          )),
        )),
      )

      // --- scjz.68: refund-reversal-aware deferred-revenue true-up inputs ---
      // (1) posted UNEARNED_REV_REVERSAL per order — deferred revenue a refund credit
      //     note already took out of the unearned account, which the true-up must not
      //     recognize again; (2) for PARTIALLY_REFUNDED orders, the per-line coverage
      //     used to decide whether the order is fully shipped net of refunds.
      const allocationById = new Map(orderAllocations.map((allocation) => [allocation.id, allocation]))
      const partialOrderIds = new Set(
        shipments.filter((shipment) => shipment.order.refundStatus === 'PARTIAL').map((shipment) => shipment.orderId),
      )

      const refunds = await tx.salesOrderRefund.findMany({
        where: { orderId: { in: orderIds } },
        select: { id: true, orderId: true },
      })
      const refundIdToOrderId = new Map(refunds.map((refund) => [refund.id, refund.orderId]))
      const reversalSyncs = await tx.accountingSyncLog.findMany({
        where: {
          connector: 'xero',
          type: 'UNEARNED_REV_REVERSAL',
          status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
          OR: [
            { referenceType: 'SalesOrder', referenceId: { in: orderIds } },
            { referenceType: 'SalesOrderRefund', referenceId: { in: refunds.map((refund) => refund.id) } },
          ],
        },
        select: { referenceType: true, referenceId: true, payload: true },
      })
      const reversalSyncsByOrder = new Map<string, Array<{ payload: unknown }>>()
      for (const sync of reversalSyncs) {
        const targetOrderId = sync.referenceType === 'SalesOrder'
          ? sync.referenceId
          : refundIdToOrderId.get(sync.referenceId)
        if (!targetOrderId) continue
        const list = reversalSyncsByOrder.get(targetOrderId) ?? []
        list.push({ payload: sync.payload })
        reversalSyncsByOrder.set(targetOrderId, list)
      }

      const shippedRowsByOrder = new Map<string, Array<{ lineId: string; productId: string; qty: number }>>()
      const refundedUnshippedRowsByOrder = new Map<string, Array<{ lineId: string; productId: string; qty: number }>>()
      if (partialOrderIds.size > 0) {
        const dispatchedShipmentLines = await tx.shipmentLine.findMany({
          where: { shipment: { orderId: { in: [...partialOrderIds] }, status: 'SHIPPED' } },
          select: { lineId: true, productId: true, qty: true, shipment: { select: { orderId: true } } },
        })
        for (const line of dispatchedShipmentLines) {
          if (!line.productId) continue
          const rows = shippedRowsByOrder.get(line.shipment.orderId) ?? []
          rows.push({ lineId: line.lineId, productId: line.productId, qty: Number(line.qty) })
          shippedRowsByOrder.set(line.shipment.orderId, rows)
        }
        // Returns of shipped units (shipment-source) do not reduce the ship
        // obligation, so only allocation-source (unshipped) refund qty counts.
        for (const refundLine of priorRefundLines) {
          for (const entry of parseCostLayerSnapshot(refundLine.costLayerSnapshot)) {
            if (entry.source !== 'allocation' || !entry.orderAllocationId) continue
            const allocation = allocationById.get(entry.orderAllocationId)
            if (!allocation?.productId || !partialOrderIds.has(allocation.orderId)) continue
            const rows = refundedUnshippedRowsByOrder.get(allocation.orderId) ?? []
            rows.push({ lineId: allocation.lineId, productId: allocation.productId, qty: toDecimal(entry.qty).toNumber() })
            refundedUnshippedRowsByOrder.set(allocation.orderId, rows)
          }
        }
      }

      const allocationAvailability = new Map<string, CostLayerSnapshotEntry[]>()
      for (const allocation of orderAllocations) {
        allocationAvailability.set(
          allocation.id,
          parseCostLayerSnapshot(allocation.costLayerSnapshot),
        )
      }

      for (const priorShipmentLine of priorShipmentLines) {
        for (const entry of parseCostLayerSnapshot(priorShipmentLine.costLayerSnapshot)) {
          if (!entry.orderAllocationId) continue
          const available = allocationAvailability.get(entry.orderAllocationId) ?? []
          // Relieve the allocation contra by QTY, not by exact costLayerId: a
          // dispatch consumes FIFO-oldest layers that can differ from the layers
          // the allocation pinned, so a costLayerId match would strand the
          // Allocated-Inventory contra (cogs-audit scjz.21).
          allocationAvailability.set(
            entry.orderAllocationId,
            reduceSnapshotByQty(available, entry.qty),
          )
        }
      }

      for (const priorRefundLine of priorRefundLines) {
        for (const entry of parseCostLayerSnapshot(priorRefundLine.costLayerSnapshot)) {
          if (entry.source !== 'allocation' || !entry.orderAllocationId) continue
          const available = allocationAvailability.get(entry.orderAllocationId) ?? []
          // Qty-based, matching the shipment relief above, so allocation availability
          // tracking is consistent and order-independent in total relieved qty (scjz.21).
          allocationAvailability.set(
            entry.orderAllocationId,
            reduceSnapshotByQty(available, entry.qty),
          )
        }
      }

      for (const shipment of shipments) {
        const existing = shipmentsByOrder.get(shipment.orderId) ?? []
        existing.push(shipment)
        shipmentsByOrder.set(shipment.orderId, existing)
      }

      for (const [orderId, orderShipments] of shipmentsByOrder) {
        const firstShipment = orderShipments[0]
        // Wrap per-order processing so a single order with a COGS gap
        // (e.g. cross-warehouse allocation mismatch, missing cost layers)
        // is skipped with an error log instead of aborting the entire
        // daily batch and rolling back every other order's revenue
        // recognition and COGS posting.
        try {
        const orderLayerDecrements = new Map<string, number>()
        const deferredBase = Number(firstShipment.order.unearnedRevenueAmount ?? firstShipment.order.totalBase)
        const orderLineTotal = firstShipment.order.lines.reduce((sum, line) => sum + Number(line.totalBase), 0)
        const requirementsByLine = new Map(
          firstShipment.order.lines
            .filter((line) => !!line.productId)
            .map((line) => [
              line.id,
              lineFulfillmentRequirements(line, graph).map((requirement) => ({
                productId: requirement.productId,
                factor: requirement.factor.toNumber(),
              })),
            ]),
        )
        const orderLineById = new Map(firstShipment.order.lines.map((line) => [line.id, line]))
        const recognizedPreviously = firstShipment.order.shipments.reduce((sum, shipment) => (
          shipment.shipmentJournalDate ? sum + Number(shipment.revenueRecognizedAmount ?? 0) : sum
        ), 0)
        // scjz.68: subtract deferred revenue a refund credit note already reversed
        // out of the unearned account so the true-up never re-recognizes it.
        const postedUnearnedReversal = sumPostedUnearnedReversal(
          reversalSyncsByOrder.get(orderId) ?? [],
          settings.xero_unearned_revenue_account,
        )
        const remainingDeferred = round2(Math.max(0, deferredBase - recognizedPreviously - postedUnearnedReversal))
        let runningRevenue = 0

        // scjz.68: a fully-shipped terminal order trues up the remainder; a
        // PARTIALLY_REFUNDED order may too, but only once every shippable line is
        // shipped net of refunds. Either way hold the true-up until this batch holds
        // the order's final dispatched-but-unjournaled shipment, so a batch-window
        // split cannot recognize a later shipment's revenue early.
        let isTrueUpEligible = isFullyShippedTerminalStatus(firstShipment.order.status) && firstShipment.order.refundStatus !== 'PARTIAL'
        if (!isTrueUpEligible && firstShipment.order.refundStatus === 'PARTIAL') {
          const combinedCoverageByLine = calculateCoverageByLine(requirementsByLine, [
            ...(shippedRowsByOrder.get(orderId) ?? []),
            ...(refundedUnshippedRowsByOrder.get(orderId) ?? []),
          ])
          isTrueUpEligible = isFullyShippedNetOfRefunds(
            firstShipment.order.lines
              .filter((line) => !!line.productId)
              .map((line) => ({
                orderedQty: Number(line.qty),
                coveredQty: combinedCoverageByLine.get(line.id) ?? 0,
              })),
          )
        }
        if (isTrueUpEligible) {
          isTrueUpEligible = batchContainsFinalUnjournaledShipment(
            firstShipment.order.shipments.filter((shipment) => shipment.status === 'SHIPPED'),
            new Set(orderShipments.map((shipment) => shipment.id)),
          )
        }

        for (let index = 0; index < orderShipments.length; index++) {
          const shipment = orderShipments[index]
          const shippedCoverageByLine = calculateCoverageByLine(
            requirementsByLine,
            shipment.lines.map((line) => ({
              lineId: line.lineId,
              productId: line.productId,
              qty: Number(line.qty),
            })),
          )
          const shipmentLineValue = [...shippedCoverageByLine.entries()].reduce((sum, [lineId, coveredQty]) => {
            const line = orderLineById.get(lineId)
            const lineQty = Number(line?.qty ?? 0)
            if (!line || lineQty <= 0 || coveredQty <= 0) return sum
            return sum + (Number(line.totalBase) * Math.min(coveredQty, lineQty)) / lineQty
          }, 0)

          const proportionalRevenue = orderLineTotal > 0
            ? round2((shipmentLineValue / orderLineTotal) * deferredBase)
            : 0
          const revenueProportion = recognizeShipmentRevenue({
            proportionalRevenue,
            remainingDeferred,
            runningRevenue,
            isFinalShipmentOfFullyShippedTerminalOrder:
              isTrueUpEligible && index === orderShipments.length - 1,
          })

          // COGS: prefer immutable shipment-line snapshots when present.
          // This ensures retrospective landed-cost updates flow through
          // stored shipment COGS without re-consuming inventory.
          const shipmentSnapshotsForLines = shipment.lines.map((line) => (
            parseCostLayerSnapshot(line.costLayerSnapshot)
          ))
          const hasPrecomputedSnapshots = shipmentSnapshotsForLines.some((entries) => entries.length > 0)
          const precomputedCogs = hasPrecomputedSnapshots
            ? roundQuantity(
                shipmentSnapshotsForLines.reduce(
                  (sum, entries) => addMoney(sum, sumCostLayerSnapshot(entries)),
                  toDecimal(0),
                ),
                2,
              )
            : toDecimal(shipment.cogsBatchAmount ?? 0)
          const precomputedCogsNumber = precomputedCogs.toNumber()
          if (hasPrecomputedSnapshots) {
            const missingSnapshotLines = shipment.lines.filter((line, lineIndex) => (
              Number(line.qty) > 0 && shipmentSnapshotsForLines[lineIndex].length === 0
            ))
            if (missingSnapshotLines.length > 0) {
              throw new Error(`Incomplete precomputed FIFO snapshots for shipment ${shipment.id}`)
            }
            const cogsBatchAmount = Number(shipment.cogsBatchAmount ?? 0)
            if (cogsBatchAmount > 0 && Math.abs(round2(cogsBatchAmount) - precomputedCogsNumber) > 0.01) {
              throw new Error(`Precomputed COGS mismatch for shipment ${shipment.id}: batch ${round2(cogsBatchAmount).toFixed(2)} != snapshots ${precomputedCogsNumber.toFixed(2)}`)
            }
          }

          // If no pre-computed COGS and no snapshots, fall back to the
          // legacy allocation-based consumption path for backward compat.
          if (!hasPrecomputedSnapshots && precomputedCogs.lte(0)) {
            const shipmentCostSnapshot: CostLayerSnapshotEntry[] = []
            for (const sl of shipment.lines) {
              let remainingQty = Number(sl.qty)
              const matchingAllocations = orderAllocations.filter((allocation) => (
                allocation.orderId === shipment.orderId
                && allocation.lineId === sl.lineId
                && allocation.productId === sl.productId
                && allocation.warehouseId === shipment.warehouseId
              ))

              for (const allocation of matchingAllocations) {
                if (remainingQty <= 0) break
                const availableEntries = allocationAvailability.get(allocation.id) ?? []
                const consumed = takeFromSnapshotEntries(availableEntries, remainingQty, {
                  orderAllocationId: allocation.id,
                  shipmentLineId: sl.id,
                  source: 'shipment',
                })
                shipmentCostSnapshot.push(...consumed.taken)
                remainingQty = consumed.remainingQty
                allocationAvailability.set(
                  allocation.id,
                  reduceSnapshotByCostLayer(
                    availableEntries,
                    consumed.taken.map((entry) => ({ costLayerId: entry.costLayerId, qty: entry.qty })),
                  ),
                )
              }

              if (remainingQty > 0.0000001) {
                throw new Error(`Missing allocated cost layers for shipment line ${sl.id}`)
              }
            }

            for (const entry of shipmentCostSnapshot) {
              orderLayerDecrements.set(
                entry.costLayerId,
                (orderLayerDecrements.get(entry.costLayerId) ?? 0) + toDecimal(entry.qty).toNumber(),
              )
            }

            const legacyCogs = roundQuantity(sumCostLayerSnapshot(shipmentCostSnapshot), 2)
            const legacyCogsNumber = legacyCogs.toNumber()
            totalRevenue += revenueProportion
            totalCogs = addMoney(totalCogs, legacyCogs)
            runningRevenue += revenueProportion
            shipmentResults.set(shipment.id, { revenue: revenueProportion, cogs: legacyCogsNumber })
            for (const sl of shipment.lines) {
              shipmentSnapshots.set(
                sl.id,
                shipmentCostSnapshot.filter((entry) => entry.shipmentLineId === sl.id),
              )
            }
          } else {
            // Pre-computed path — snapshots already stored on shipment lines
            totalRevenue += revenueProportion
            totalCogs = addMoney(totalCogs, precomputedCogs)
            runningRevenue += revenueProportion
            shipmentResults.set(shipment.id, { revenue: revenueProportion, cogs: precomputedCogsNumber })
            // Snapshots are already on the shipment lines — no need to
            // write them again or track layerDecrements (already consumed)
          }
        }
        // Only publish legacy FIFO decrements after the whole order succeeds.
        // Failed orders keep shipmentJournalDate null and must not mutate layer
        // balances before their next retry.
        for (const [layerId, decrement] of orderLayerDecrements) {
          layerDecrements.set(layerId, (layerDecrements.get(layerId) ?? 0) + decrement)
        }
        } catch (orderError) {
          // Per-order failure: skip this order, log the error, continue
          // with remaining orders so the batch isn't blocked by one bad order.
          const orderRef = firstShipment.order.orderNumber ?? firstShipment.order.externalOrderNumber ?? orderId.slice(0, 8)
          result.errors.push(`Group B order ${orderRef}: ${String(orderError)}`)
          // Remove any partially-accumulated results for this order's shipments
          for (const s of orderShipments) {
            const sr = shipmentResults.get(s.id)
            if (sr) {
              totalRevenue -= sr.revenue
              totalCogs = subtractMoney(totalCogs, sr.cogs)
              shipmentResults.delete(s.id)
            }
            for (const sl of s.lines) shipmentSnapshots.delete(sl.id)
          }
        }
      }

      const journalLines: JournalLinePayload[] = []
      const processedShipmentCount = shipmentResults.size
      const totalCogsNumber = round2Decimal(totalCogs)

      if (totalRevenue > 0) {
        journalLines.push(
          { accountCode: settings.xero_unearned_revenue_account, description: `Revenue recognition — ${processedShipmentCount} shipment(s)`, debit: totalRevenue },
          { accountCode: settings.xero_sales_account, description: `Revenue recognition — ${processedShipmentCount} shipment(s)`, credit: totalRevenue },
        )
      }

      if (totalCogsNumber > 0) {
        journalLines.push(
          { accountCode: settings.xero_cogs_account, description: `COGS — ${processedShipmentCount} shipment(s)`, debit: totalCogsNumber },
          { accountCode: settings.xero_allocated_inventory_account, description: `COGS — ${processedShipmentCount} shipment(s)`, credit: totalCogsNumber },
        )
      }

      // o3d-0qoo: identity over the shipments that actually made it into this batch —
      // shipmentResults has already had failed orders' shipments removed, and the stamping
      // loop below skips exactly the same ones, so the digest input and the stamped set are
      // the same set by construction. Persisted per shipment rather than re-derived from
      // shipmentJournalDate, which is written later and can land on the next UTC day.
      const referenceId = buildDailyBatchReferenceId('B', today, [...shipmentResults.keys()])

      // o3d-o97 r4: null unless a journal row was created AND it carried a CR Allocated Inventory
      // line. Both halves matter, and they are not the same guard: the log is skipped entirely when
      // the window produced no lines at all, and — separately — a window whose ROUNDED COGS total is
      // zero still raises a revenue-only journal that credits Allocated Inventory NOTHING, while
      // `allocatedReliefAmount` below is stamped on every member shipment regardless. Stamping the
      // id off `journalLines.length` alone would attribute a credit to a journal that does not
      // contain one, which is the same amount-implies-a-posting inference in a new place.
      let groupBSyncLogId: string | null = null
      if (journalLines.length > 0) {
        const createdLogId = await createPendingSyncLog(tx, {
          type: 'DAILY_BATCH_GROUP_B',
          referenceId,
          currency: baseCurrency,
          payload: {
            date: today,
            reference: `Shipment COGS ${today} ${referenceId.slice(-8)}`,
            narration: `Daily shipment batch: ${processedShipmentCount} shipment(s), revenue £${totalRevenue.toFixed(2)}, COGS £${totalCogsNumber.toFixed(2)}`,
            lines: journalLines,
            batchReferenceId: referenceId,
            batchDate: today,
            batchGroup: 'B',
            batchEntityCount: processedShipmentCount,
            splitBatch: result.hasMore.groupB,
            _postingMode: 'submitted',
          },
        })
        if (totalCogsNumber > 0) groupBSyncLogId = createdLogId
      }

      // Only mark shipments that were successfully processed. Failed
      // orders had their results removed from shipmentResults by the
      // per-order catch block — those shipments must remain untouched
      // (shipmentJournalDate stays null) so the next batch run retries.
      for (const shipment of shipments) {
        const resultForShipment = shipmentResults.get(shipment.id)
        if (!resultForShipment) continue // failed order — skip, leave retryable
        for (const line of shipment.lines) {
          const lineSnapshot = shipmentSnapshots.get(line.id)
          if (lineSnapshot) {
            await tx.shipmentLine.update({
              where: { id: line.id },
              data: {
                costLayerSnapshot: lineSnapshot as never,
              },
            })
          }
        }
        const shipmentJournalDate = new Date()
        await tx.shipment.update({
          where: { id: shipment.id },
          data: {
            shipmentJournalDate,
            shipmentJournalBatchRef: referenceId,
            cogsBatchAmount: resultForShipment.cogs,
            revenueRecognizedAmount: resultForShipment.revenue,
            // o3d-o97 r3: the CR Allocated Inventory this shipment's share of the journal above
            // raised — the same figure as the COGS debit, recorded once and never revalued.
            // `cogsBatchAmount` on the line above carries the same number TODAY and a different
            // one after the next landed-cost correction rewrites it in place.
            allocatedReliefAmount: resultForShipment.cogs,
            // o3d-o97 r4: and WHICH journal raised it, on WHICH ledger, against WHICH account —
            // all null when no CR Allocated Inventory line was raised at all. The refund resolves
            // the id back to the row to read its STATUS, so a Group B journal still queued, or one
            // that ended CANCELLED, is never counted as relief the contra has already received.
            allocatedReliefSyncLogId: groupBSyncLogId,
            allocatedReliefConnector: groupBSyncLogId ? XERO_CONNECTOR : null,
            allocatedReliefAccountCode: groupBSyncLogId ? settings.xero_allocated_inventory_account : null,
          },
        })
        // khdw: record this shipment's dispatch COGS in the COGS subledger ledger as
        // an immutable, correctly-dated row. The reconciliation reads the ledger (not
        // the live, revaluation-mutated cogsBatchAmount), so a same-window dispatch +
        // revaluation can't double-count. Idempotent per shipment.
        //
        // Dated on `today` — the BATCH's date — NOT on shipmentJournalDate (o3d-0qoo r1,
        // found by Codex). The GL journal above is posted under `today`, while the stamp is
        // written with a later new Date(); on a midnight-crossing run the two differ, and
        // the subledger row would land a day after the journal whose value it records.
        // Reconciliation windows on journalDate, so that gap reads as a real one — and
        // because this upsert is first-write-wins and keyed per shipment, a row written on
        // the wrong day can never be corrected by a later run.
        await recordCogsSubledgerMovement(tx, {
          sourceType: 'DISPATCH',
          sourceRef: shipment.id,
          idempotencyKey: `dispatch:${shipment.id}`,
          baseDelta: resultForShipment.cogs,
          journalDate: today,
        })
      }

      for (const [layerId, decrement] of layerDecrements) {
        await tx.costLayer.update({
          where: { id: layerId },
          data: { remainingQty: { decrement } },
        })
      }

      return processedShipmentCount
    })
    if (groupBCount > 0) {
      result.groupB = groupBCount
    }
  } catch (e) {
    result.errors.push(`Group B error: ${String(e)}`)
  }

    // cogs-audit scjz.60.4: sweep the inventory subledger-vs-GL rounding residue to
    // the rounding-difference account. Runs after the batch postings so the GL/
    // subledger snapshots it compares already reflect this run's journals. Guarded:
    //  - a rounding-difference account must be configured (its absence is the opt-out;
    //    residue is then accepted within tolerance, no line posted),
    //  - the comparison must be available (both GL accounts mapped AND point-in-time
    //    snapshots exist for the as-of date), and
    //  - the gap must be pure accumulated rounding ('sweep'); a material gap ('flag')
    //    is surfaced by the reconciliation invariant and NEVER swept (sweeping it
    //    would mask a genuine misstatement).
    // Idempotent per as-of date via dailyBatchRecreateVerdict, so re-running the batch the
    // same period never double-posts. A failure here must never abort the batch — the
    // core postings already committed.
    result.inventoryReconciliationSwept = null
    try {
      const reconciliation = await loadInventoryGlReconciliation()
      const journal = buildInventoryReconciliationSweepJournal(reconciliation, {
        inventoryAccount: settings.xero_inventory_account ?? '',
        roundingAccount: settings.xero_rounding_difference_account ?? '',
        currency: baseCurrency,
      })
      if (journal) {
        const referenceId = `INVRECON-${journal.date}`
        // o3d-o97 r6: the same idempotency guard the recreate sweep uses, and for the same reason —
        // a CANCELLED sweep journal for this as-of date does not establish that nothing was posted,
        // so it blocks a second one and is reported rather than silently re-raised.
        const reconciliationVerdict = await dailyBatchRecreateVerdict('DAILY_BATCH_INVENTORY_RECONCILIATION', referenceId)
        if (reconciliationVerdict.refusal) result.errors.push(reconciliationVerdict.refusal)
        if (!reconciliationVerdict.blocked) {
          await db.$transaction((tx) => createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_INVENTORY_RECONCILIATION',
            referenceId,
            currency: baseCurrency,
            payload: {
              date: journal.date,
              reference: `Inventory reconciliation ${journal.date}`,
              narration: journal.narration,
              lines: journal.lines,
              batchReferenceId: referenceId,
              batchDate: journal.date,
              batchGroup: 'INVENTORY_RECONCILIATION',
              _postingMode: 'submitted',
            },
          }))
          // delta is signed (subledger - GL); records both magnitude and direction.
          result.inventoryReconciliationSwept = journal.subledgerHigher ? journal.amount : -journal.amount
        }
      }
    } catch (e) {
      result.errors.push(`Inventory reconciliation sweep error: ${String(e)}`)
    }

    // khdw: COGS subledger-vs-GL rounding sweep — same guard/idempotency/safety as
    // the inventory sweep above, on the COGS account. Reconciles the PERIOD MOVEMENT
    // (Σ dispatch cogsBatchAmount − Σ refund cogsReversalBase over the GL window) vs
    // the COGS account GL movement; sub-penny → swept, material → flagged (never
    // swept). Independent of inventory; a failure must never abort the batch.
    result.cogsReconciliationSwept = null
    try {
      const reconciliation = await loadCogsGlReconciliation()
      const journal = buildCogsReconciliationSweepJournal(reconciliation, {
        cogsAccount: settings.xero_cogs_account ?? '',
        roundingAccount: settings.xero_rounding_difference_account ?? '',
        currency: baseCurrency,
      })
      if (journal) {
        const referenceId = `COGSRECON-${journal.date}`
        // o3d-o97 r6: the same idempotency guard the recreate sweep uses, and for the same reason —
        // a CANCELLED sweep journal for this as-of date does not establish that nothing was posted,
        // so it blocks a second one and is reported rather than silently re-raised.
        const reconciliationVerdict = await dailyBatchRecreateVerdict('DAILY_BATCH_COGS_RECONCILIATION', referenceId)
        if (reconciliationVerdict.refusal) result.errors.push(reconciliationVerdict.refusal)
        if (!reconciliationVerdict.blocked) {
          await db.$transaction((tx) => createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_COGS_RECONCILIATION',
            referenceId,
            currency: baseCurrency,
            payload: {
              date: journal.date,
              reference: `COGS reconciliation ${journal.date}`,
              narration: journal.narration,
              lines: journal.lines,
              batchReferenceId: referenceId,
              batchDate: journal.date,
              batchGroup: 'COGS_RECONCILIATION',
              _postingMode: 'submitted',
            },
          }))
          // delta is signed (subledger - GL); records both magnitude and direction.
          result.cogsReconciliationSwept = journal.subledgerHigher ? journal.amount : -journal.amount
        }
      }
    } catch (e) {
      result.errors.push(`COGS reconciliation sweep error: ${String(e)}`)
    }

    // 6oyu.4 (khdw): STOCK_IN_TRANSIT subledger-vs-GL rounding sweep — same
    // guard/idempotency/safety as the inventory + COGS sweeps above, on the transit
    // clearing account. Reconciles the PERIOD MOVEMENT (Σ signed transit subledger
    // rows over the GL window) vs the transit account GL movement; sub-penny → swept,
    // material → flagged (never swept — an uninstrumented transit flow or a genuine
    // misstatement must surface, not be masked). Independent of inventory/COGS; a
    // failure must never abort the batch (the core postings already committed).
    result.transitReconciliationSwept = null
    try {
      const reconciliation = await loadTransitGlReconciliation()
      const journal = buildTransitReconciliationSweepJournal(reconciliation, {
        transitAccount: settings.xero_transit_account ?? '',
        roundingAccount: settings.xero_rounding_difference_account ?? '',
        currency: baseCurrency,
      })
      if (journal) {
        const referenceId = `TRANSITRECON-${journal.date}`
        // o3d-o97 r6: the same idempotency guard the recreate sweep uses, and for the same reason —
        // a CANCELLED sweep journal for this as-of date does not establish that nothing was posted,
        // so it blocks a second one and is reported rather than silently re-raised.
        const reconciliationVerdict = await dailyBatchRecreateVerdict('DAILY_BATCH_TRANSIT_RECONCILIATION', referenceId)
        if (reconciliationVerdict.refusal) result.errors.push(reconciliationVerdict.refusal)
        if (!reconciliationVerdict.blocked) {
          await db.$transaction((tx) => createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_TRANSIT_RECONCILIATION',
            referenceId,
            currency: baseCurrency,
            payload: {
              date: journal.date,
              reference: `Transit reconciliation ${journal.date}`,
              narration: journal.narration,
              lines: journal.lines,
              batchReferenceId: referenceId,
              batchDate: journal.date,
              batchGroup: 'TRANSIT_RECONCILIATION',
              _postingMode: 'submitted',
            },
          }))
          // delta is signed (subledger - GL); records both magnitude and direction.
          result.transitReconciliationSwept = journal.subledgerHigher ? journal.amount : -journal.amount
        }
      }
    } catch (e) {
      result.errors.push(`Transit reconciliation sweep error: ${String(e)}`)
    }

    // Log summary
    if (result.groupA1 > 0 || result.groupA2 > 0 || result.groupB > 0) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'xero_daily_batch',
        tag: 'sync',
        level: 'INFO',
        description: `Daily batch: A1=${result.groupA1} deferred, A2=${result.groupA2} allocated, B=${result.groupB} shipped`,
        metadata: result,
        resolveUser: false,
      })
    }

    return result
  } finally {
    await batchLock.release()
  }
}
