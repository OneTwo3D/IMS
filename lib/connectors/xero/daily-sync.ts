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

import { withLedgerCheck } from '@/lib/domain/accounting/hand-post-instruction'
import { createAccountingSyncLogRow } from '@/lib/domain/accounting/sync-log-row'
import { xeroBeforeCutoffRefusal, xeroCutoffFloor, xeroNotBeforeCutoffWhere, xeroProducerSeamVerdict } from '@/lib/domain/accounting/xero-producer-seam'
import { readProducerEnforcement } from '@/lib/security/producer-seam'
import { createHash } from 'node:crypto'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { getXeroSettings } from '@/lib/connectors/xero/settings'
import {
  StaleDailyBatchDeferralError,
  assertRevenueDeferralsUnchanged,
  preBatchRefundDeferredParts,
  preBatchRefundsNettedIntoStoredDeferral,
  revenueDeferralGrossAmount,
  logStaleDailyBatchDeferral,
  revenueDeferralAmount,
} from '@/lib/domain/accounting/daily-batch-discount-fence'
import { Prisma } from '@/app/generated/prisma/client'
import {
  mirrorAccountingSyncLogToEvent,
  resetMirroredAccountingEventsToPending,
} from '@/lib/domain/accounting/accounting-event-mirror'
import { scheduleXeroAccountingOutbox } from '@/lib/connectors/xero/outbox'
import { stampingCustodyOnCreate } from '@/lib/domain/accounting/money-attempt-provenance'
import { activeAccountingIdProvenance } from '@/lib/connectors/accounting-id-provenance'
import {
  mintAccountingConnectionProvenanceColumn,
  stampAccountingPayloadConnection,
} from '@/lib/connectors/accounting-connection-provenance'
import {
  accountedAllocationQty,
  parseCostLayerSnapshot,
  recordedPostedBasis,
  reduceSnapshotByCostLayer,
  reduceSnapshotByQty,
  sumCostLayerSnapshot,
  sumCostLayerSnapshotQty,
  takeFromSnapshotEntries,
  unaccountedAllocationQty,
  unrecordedShipmentEntries,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'
import {
  assertGroupBSnapshotsWereLocked,
  groupBShipmentWhere,
  groupBShipmentBelongsToPass,
  shippedBeforePayment,
  lockCostLayersForGroupBWindow,
} from '@/lib/domain/accounting/daily-batch-group-b-lock'
import { addMoney, roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { GL_BASE_PRECISION, roundToGlPrecisionNumber } from '@/lib/domain/math/precision-policy'
import { buildInventoryReconciliationSweepJournal, loadInventoryGlReconciliation } from '@/lib/domain/accounting/inventory-gl-reconciliation'
import { buildCogsReconciliationSweepJournal, loadCogsGlReconciliation } from '@/lib/domain/accounting/cogs-gl-reconciliation'
import { buildTransitReconciliationSweepJournal, loadTransitGlReconciliation } from '@/lib/domain/accounting/transit-gl-reconciliation'
import {
  allocationDebitRecreateRefusal,
  allocationDebitRecreateTargets,
  allocationDebitForeignLedgerReports,
  buildAllocationDebitOrderUpdate,
  foldA2RecreateOrder,
  foreignJournalStateOf,
  newA2RecreateSummary,
  repointAllocationDebitPassesToRecreatedJournal,
  type A2RecreateSummary,
  type AllocationDebitBatchLedger,
  type ForeignJournalState,
} from '@/lib/domain/accounting/allocation-debit-passes'
import { recordCogsSubledgerMovement } from '@/lib/domain/accounting/cogs-subledger-movement'
import { recordTransitSubledgerMovement } from '@/lib/domain/accounting/transit-subledger-movement'
import { GRIR_BALANCE_SOURCE_TYPES } from '@/lib/domain/accounting/grir-subledger-movement'
import { buildGrirReclassJournal, buildGrirReclassReferenceId, netGrirMovements } from '@/lib/domain/accounting/grir-reclass-journal'
import { loadUnjournaledReturnCredits, unjournaledReturnKey } from '@/lib/domain/accounting/unjournaled-return-cogs'
import { clampRecreateWindowToCutoff, recreateRetentionWindow } from '@/lib/domain/accounting/daily-batch-retention'
import { isOperatorAssertedSettlement } from '@/lib/domain/accounting/sync-row-settlement'
import { cancelledClaimIsResolved } from '@/lib/domain/accounting/unresolved-abandoned-claim'
import {
  dailyBatchLiveRefs,
  foldDailyBatchRow,
  LIVE_DAILY_BATCH_STATUSES,
  type DailyBatchLiveRefs,
  type DailyBatchRecreateBucket,
} from '@/lib/domain/accounting/daily-batch-reference'
import { resolveScheduledDailyBatchSweep } from '@/lib/domain/accounting/daily-batch-sweep-schedule'
import { calculateCoverageByLine } from '@/lib/products/fulfillment-coverage'
import { isFullyShippedTerminalStatus, recognizeShipmentRevenue } from '@/lib/domain/accounting/revenue-recognition'
import {
  UNEARNED_REVERSAL_NETTING_WHERE,
  countedUnearnedReversalRows,
  describeUnearnedReversalReport,
  sumPostedUnearnedReversal,
  unreadableUnearnedReversalRows,
  isFullyShippedNetOfRefunds,
  batchContainsFinalUnjournaledShipment,
  unearnedReversalStandingReport,
  type UnearnedReversalSyncRow,
} from '@/lib/domain/accounting/deferred-trueup'
import { LEDGER_STANDING_SELECT, isShadowedObligation, type LedgerStandingRow } from '@/lib/domain/accounting/ledger-standing'
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
import { refreshXeroBooksLockDate } from '@/lib/connectors/xero/books-lock-date'
import { businessDateYmd } from '@/lib/business-date'
import { groupByPostingDate, isOnOrBeforeLock, laterDay, lockBlocksRun, lockBlocksRunMessage, lockedJournalSkipMessage, lockedPeriodNarration, parseBatchDay, businessDay } from '@/lib/domain/accounting/daily-batch-event-date'
import { acquirePinnedAdvisoryLockOrNull } from '@/lib/db/pinned-advisory-lock'
const XERO_CONNECTOR = 'xero'
export const XERO_DAILY_BATCH_DEFAULT_LIMIT = 1_000
export const XERO_DAILY_BATCH_MAX_LIMIT = 5_000
/** Group B row-locks up to a whole batch window of orders and cost layers; Prisma's 5 s default would roll it back on one busy order. */
export const GROUP_B_TX_OPTIONS = { maxWait: 10_000, timeout: 120_000 }
const DAILY_BATCH_TYPES = [
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
  'DAILY_BATCH_INVENTORY_RECONCILIATION',
  'DAILY_BATCH_COGS_RECONCILIATION',
  'DAILY_BATCH_TRANSIT_RECONCILIATION',
  'DAILY_BATCH_GRIR_RECLASS',
] as const

// GL postings round to the canonical GL precision (cogs-audit scjz.60); these
// thin aliases keep call sites terse while the precision lives in one place.
function round2(value: number): number {
  return roundToGlPrecisionNumber(value)
}

function round2Decimal(value: Decimal): number {
  return roundQuantity(value, GL_BASE_PRECISION).toNumber()
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
  lines: TLine[]
  /**
   * ACC-H12: set when the daily batch already relieved this shipment's COGS straight out of Inventory
   * (DR COGS / CR Inventory) because the order had not been deferred when the goods left. Its units are
   * COSTED: Allocated Inventory never held a debit for them, so Group A2 neither values them from the
   * shipment snapshots nor counts them against the allocation row's pin.
   */
  cogsRelievedFromInventoryAt?: Date | string | null
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
 *   outstandingByAllocation     allocated quantity nothing has reclassified, to be valued by pinning
 *                               FIFO layers — but only the outstanding PART of each row, per
 *                               {@link unaccountedAllocationQty}.
 *   shipmentAccountedByAllocation
 *                               dispatched quantity at the row's scope that no entry on the row
 *                               accounts for, valued from the SHIPMENT snapshots because dispatch
 *                               has already consumed those layers and A2 cannot pin them.
 *
 * THE PASS RECORDS WHAT IT ACCOUNTED THROUGH A SHIPMENT (o3d-0i5y r6). r5 left no record of those
 * units, so the next pass saw a residual pin (4 on the shelf) beside a shipment that PREDATES it (6
 * dispatched) and had to guess whether they were the same units. Its `max` said 6 accounted where 10
 * were, and it re-pinned and RE-POSTED the residual — every time the order came back. Writing those
 * units onto the row as shipment-source entries makes the pin the complete record of accounted
 * quantity, so the guess is gone: a dispatch can only consume a pin that already existed, and a
 * shipment-source entry is proof that it did not.
 *
 * AND THE JOURNAL DATE DECIDES NOTHING HERE ANY MORE (o3d-0i5y r7). r5 valued the whole of every
 * UNJOURNALED shipment and excluded journaled ones, reading a journal date as proof A2 had posted
 * that shipment's cost. It is not: Group B refuses to journal an unstamped ORDER, which says nothing
 * about which of that order's units A2 pinned. Both halves of that read are wrong once a shipment is
 * MIXED — part of it pinned by an earlier pass, part of it not:
 *
 *   an unjournaled mixed shipment had its already-pinned part re-posted, on that pass and every
 *   later one, because the whole shipment was valued;
 *   a journaled shipment's UNPINNED part was never posted at all, though Group B had already
 *   credited Allocated Inventory for the whole shipment's value when it journaled it.
 *
 * Both disappear when value follows the record: the pass posts exactly the entries it writes, and
 * `shipmentAccountedByAllocation` is by construction the dispatched quantity the row does not
 * already account for.
 *
 * `stampEmptyAllocationIds` are rows that owe nothing, have nothing to record and have never been
 * stamped; they keep the pre-existing empty-snapshot stamp. Rows that already carry a snapshot and
 * owe nothing appear in NO list and must be left completely alone — that snapshot is the posted
 * evidence Group B and the refund reversal resolve their cost basis through.
 */
export function planA2Reclassification<TLine extends { lineId: string; productId: string | null; qty: Prisma.Decimal | number }, TShipment extends A2ShipmentRow<TLine>>(order: {
  allocations: A2AllocationRow[]
  shipments: TShipment[]
}): {
  outstandingByAllocation: Map<string, Decimal>
  shipmentAccountedByAllocation: Map<string, Decimal>
  stampEmptyAllocationIds: string[]
} {
  const scopeKey = (lineId: string, warehouseId: string, productId: string) => `${lineId}|${warehouseId}|${productId}`
  const shippedQtyByScope = new Map<string, Decimal>()
  // ACC-H12: units a direct-to-Inventory shipment already costed. They are neither dispatched-and-unrecorded
  // (A2 would value them from the shipment snapshots and debit Allocated Inventory for stock that was never
  // allocated-and-pinned) nor part of what is still to be pinned, so they come off the row's allocated quantity.
  const costedQtyByScope = new Map<string, Decimal>()
  for (const shipment of order.shipments) {
    const target = shipment.cogsRelievedFromInventoryAt ? costedQtyByScope : shippedQtyByScope
    for (const line of shipment.lines) {
      if (!line.productId) continue
      const key = scopeKey(line.lineId, shipment.warehouseId, line.productId)
      target.set(key, (target.get(key) ?? toDecimal(0)).add(toDecimal(line.qty)))
    }
  }

  const outstandingByAllocation = new Map<string, Decimal>()
  const shipmentAccountedByAllocation = new Map<string, Decimal>()
  const stampEmptyAllocationIds: string[] = []
  for (const alloc of order.allocations) {
    const snapshot = parseCostLayerSnapshot(alloc.costLayerSnapshot)
    const shippedQty = shippedQtyByScope.get(scopeKey(alloc.lineId, alloc.warehouseId, alloc.productId)) ?? 0
    const { accounted, unrecordedShippedQty } = accountedAllocationQty({ snapshot, shippedQty })
    const costedQty = costedQtyByScope.get(scopeKey(alloc.lineId, alloc.warehouseId, alloc.productId))
    const outstanding = unaccountedAllocationQty({
      allocatedQty: costedQty ? toDecimal(alloc.qty).sub(costedQty) : alloc.qty,
      snapshot,
      shippedQty,
    })
    if (outstanding.gt(0)) outstandingByAllocation.set(alloc.id, outstanding)
    // Recorded even when the row owes nothing else: the record is what stops the NEXT pass
    // re-deriving these units from an overlap it cannot resolve, which is the double post.
    if (unrecordedShippedQty.gt(0)) shipmentAccountedByAllocation.set(alloc.id, unrecordedShippedQty)
    else if (accounted.lte(0) && outstanding.lte(0) && alloc.costLayerSnapshot === null) {
      stampEmptyAllocationIds.push(alloc.id)
    }
  }

  return {
    outstandingByAllocation,
    shipmentAccountedByAllocation,
    stampEmptyAllocationIds,
  }
}

/**
 * The entries that RECORD dispatched units as accounted, taken from the shipment lines that dispatched
 * them (o3d-0i5y r6).
 *
 * They carry the layers dispatch actually consumed, so the record is a truthful cost basis and not a
 * placeholder: Group B and the refund reversal both relieve the Allocated-Inventory contra by QTY
 * against these same entries, and both already subtract every shipment line's quantity from the row,
 * so recording the shipped units leaves the row holding exactly the UNSHIPPED remainder instead of
 * being driven straight through zero.
 *
 * They are decorated with `source: 'shipment'`, which is the marker {@link accountedAllocationQty}
 * reads to know these units are DISJOINT from the allocated pin rather than overlapping it.
 *
 * o3d-0i5y r8: AND THE POOL IS NETTED BY THE ROW'S OWN RECORD FIRST. Taking from every dispatched
 * line at the scope, as r6/r7 did, re-offers the entries an earlier pass already recorded and
 * posted — so a second shipment's units were valued at the FIRST shipment's layers, posting its
 * cost a second time. `recorded` is that row's existing snapshot, and
 * {@link unrecordedShipmentEntries} subtracts it before anything is taken, which makes valuing an
 * entry twice impossible rather than merely unlikely. See the worked example there.
 */
export function takeShipmentAccountedEntries(
  recorded: CostLayerSnapshotEntry[],
  lines: Array<{ id: string; costLayerSnapshot: Prisma.JsonValue | null }>,
  qty: Decimal,
  allocationId: string,
): CostLayerSnapshotEntry[] {
  const dispatched = lines.flatMap((line) => (
    parseCostLayerSnapshot(line.costLayerSnapshot).map((entry) => ({
      ...entry,
      shipmentLineId: entry.shipmentLineId ?? line.id,
    }))
  ))
  const available = unrecordedShipmentEntries(recorded, dispatched)
  return takeFromSnapshotEntries(available, qty.toNumber(), {
    orderAllocationId: allocationId,
    source: 'shipment',
  }).taken
}

/**
 * Stamp an entry with the amount the pass that is writing it is posting for it (o3d-0i5y r9).
 *
 * Called ONLY on entries the current A2 pass values into its own journal, so the stamp and the
 * posting are the same event. An entry that already carries a stamp keeps it — that entry was
 * valued by an earlier pass, and its posting was a different journal for a possibly different
 * amount.
 */
function withPostedUnitCost(entry: CostLayerSnapshotEntry): CostLayerSnapshotEntry {
  return entry.postedUnitCostBase != null
    ? entry
    : { ...entry, postedUnitCostBase: entry.unitCostBase }
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

/**
 * o3d-sidy: hand back what `consumeSnapshotLayers` took, entry by entry, so an order Group A2 refuses
 * leaves the in-memory layer snapshot exactly as it found it for the orders valued after it.
 */
function returnSnapshotLayers(
  snapshot: LayerSnapshot,
  productId: string,
  warehouseId: string,
  consumed: CostLayerSnapshotEntry[],
): void {
  const layers = snapshot.get(makeLayerKey(productId, warehouseId)) ?? []
  for (const entry of consumed) {
    const layer = layers.find((candidate) => candidate.id === entry.costLayerId)
    if (layer) layer.remainingQty += toDecimal(entry.qty).toNumber()
  }
}

type PendingSyncLogParams = {
  type: 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B' | 'DAILY_BATCH_INVENTORY_RECONCILIATION' | 'DAILY_BATCH_COGS_RECONCILIATION' | 'DAILY_BATCH_TRANSIT_RECONCILIATION' | 'DAILY_BATCH_GRIR_RECLASS'
  referenceId: string
  payload: Record<string, unknown>
  currency: string
}

async function createPendingSyncLog(
  tx: AccountingMirrorClient,
  params: PendingSyncLogParams,
  /** Optional: set to whether the journal was QUEUED (false = the producer hold recorded a shadow and nothing was queued). */
  outcome?: { queued: boolean },
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
  const created = await createAccountingSyncLogRow(tx, {
      connector: XERO_CONNECTOR,
      type: params.type,
      status: 'PENDING',
      referenceType: 'DailyBatch',
      referenceId: params.referenceId,
      // The CONNECTION-STAMPED payload (o3d-s36z), not `params.payload`. Writing the raw one here
      // would drop the stamp the const above exists to add, and the processor would refuse the row
      // at post time as 'no-origin-recorded'.
      payload: payload as never,
      // o3d-dzip: the DURABLE half of the same origin record, minted from the stamp in the payload
      // this statement is writing. Retention compacts the payload to `{}` and keeps the external id,
      // so a stamp that lives only in the payload is missing from exactly the rows whose realm is
      // least knowable. Minted here and nowhere else — see mintAccountingConnectionProvenanceColumn
      // for why this is not a back-fill.
      connectionProvenance: mintAccountingConnectionProvenanceColumn(payload),
      // o3d-0m56 r10: created INSIDE attempt-stamping custody. That is what later lets a revival
      // read this row's unset `remoteAttemptedAt` as proof no remote call ever left it — see
      // money-attempt-provenance.ts. A row created without it is never recycled again.
      ...stampingCustodyOnCreate(),
    })
  // o3d-j625 r7: a daily-batch journal has no refusal kind, so nothing can mark it handled and the
  // primitive cannot suppress it. If that ever changes, this must decide what a suppressed batch means
  // rather than carry on without a row.
  //
  // o3d-j625 r18: and it now says WHICH suppression it would have been, because the two need opposite
  // handling if this ever becomes reachable — a completed hand posting means the batch is in the ledger, a
  // live claim means it is not yet and the batch must be re-driven after the claim ends.
  if (created.suppressed !== null) {
    throw new Error(
      `Daily-batch journal ${params.type} ${params.referenceId} was suppressed (${created.suppressed}), which no `
      + 'daily-batch posting can be: no refusal kind names one, so nothing can claim or mark it.',
    )
  }
  // The producer-side hold said SHADOW: the journal is recorded as a shadow and NOTHING is queued - no outbox job and no
  // accounting event. The shadow row's own id is returned (status CANCELLED, never posted by IMS), so the batch stamps
  // the rows it was built from with an id whose status says what happened to it, exactly as for a queued journal.
  if (outcome) outcome.queued = false
  if (created.shadowed) return created.shadowed.id
  if (outcome) outcome.queued = true
  const log = created.row
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

/**
 * The orders Group A2 may reclassify. Held as one constant because it is asked TWICE — once to
 * pick candidates, once again under their row locks — and the second ask is the one that
 * authorises the posting, so the two must not be able to drift apart (o3d-0i5y r9).
 */
const A2_ELIGIBLE_ORDER: Prisma.SalesOrderWhereInput = {
  revenueDeferredDate: { not: null },
  inventoryAllocatedDate: null,
  status: { in: ['ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED'] },
  refundStatus: { not: 'FULL' },
}

const A2_ORDER_SELECTION_ORDER: Prisma.SalesOrderOrderByWithRelationInput[] = [
  { revenueDeferredDate: 'asc' },
  { id: 'asc' },
]

/**
 * Row-lock every order this A2 pass is about to plan from and stamp (o3d-0i5y r9).
 *
 * Locked in ID order, and BEFORE any other lock this transaction takes, which is what keeps it
 * deadlock-free against the allocation path: every writer in this domain takes its sales-order
 * lock first (`lockSalesOrder`) and its stock/cost-layer locks after, so a transaction holding a
 * lock A2 wants can never be waiting on a lock A2 holds.
 */
async function lockSalesOrders(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "sales_orders" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`,
  )
}

/**
 * Row-lock the allocation rows this A2 pass is about to write, and hand back the record each one
 * holds AS OF THE LOCK (o3d-0i5y r10 — Codex round 10, finding 4).
 *
 * The sales-order lock r9 introduced does not cover these rows. `updateSnapshotsForCostLayerChange`
 * — the late-landed-cost correction — rewrites `unitCostBase` on `order_allocations` directly,
 * selecting them by `costLayerSnapshot @> [{costLayerId}] FOR UPDATE` and taking NO sales-order
 * lock at all, because it is a purchasing-side sweep that does not know which orders it will touch.
 * So it is the one writer that can move a row A2 has already read.
 *
 * TAKEN HERE, NOT AT THE TOP OF THE TRANSACTION. Locking these rows before `buildLayerSnapshot`
 * would put A2 on order_allocations → cost_layers while the correction runs cost_layers →
 * order_allocations, which is a deadlock cycle between two writers that both matter. Taken at the
 * point the `UPDATE` would take the row lock anyway, the ordering is unchanged and nothing new can
 * wait on anything new.
 *
 * Ordered by id so two lockers of the same set queue rather than interleave.
 */
async function lockAllocationRecords(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<Map<string, Prisma.JsonValue | null>> {
  if (ids.length === 0) return new Map()
  const rows = await tx.$queryRaw<Array<{ id: string; costLayerSnapshot: Prisma.JsonValue | null }>>(
    Prisma.sql`SELECT id, "costLayerSnapshot" FROM "order_allocations" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`,
  )
  return new Map(rows.map((row) => [row.id, row.costLayerSnapshot ?? null]))
}

/**
 * ACC-H11: a journal dated on or before the Xero books lock date is never queued by the batch - not as a fresh
 * journal, not as a requeue of a failed one, not as a rebuild, not as a reconciliation sweep. Said once, in the
 * activity log, with what was skipped and why. Returns true when the journal must be skipped.
 */
async function skipJournalInLockedPeriod(what: string, day: string | null | undefined, lockDate: string | null | undefined): Promise<boolean> {
  if (!lockDate || !isOnOrBeforeLock(day, lockDate)) return false
  await logActivity({
    entityType: 'SYSTEM',
    action: 'daily_batch_journal_skipped_locked_period',
    tag: 'sync',
    level: 'WARNING',
    description: lockedJournalSkipMessage(what, day as string, lockDate),
    metadata: { what, day, lockDate },
    resolveUser: false,
  }).catch(() => { /* a report that cannot be written must not change what the batch did */ })
  return true
}

export async function resetFailedDailyBatchLogs(lockDate: string | null = null): Promise<void> {
  // THE PRODUCER-SIDE HOLD AT THE RE-QUEUE. The verdict is decided FIRST, on the switch and the destination alone.
  // Not enforced for Xero (the default): the ORIGINAL statements run unchanged - a status-wide reset that takes every
  // batch row FAILED at execution time, including one that failed after any earlier read - so the switch-off
  // behaviour is byte-identical to before the hold existed.
  const enforcement = readProducerEnforcement(process.env)
  if (!enforcement.enforced || !enforcement.destinations.has(XERO_CONNECTOR)) {
    // With a lock date known, a FAILED row whose own date is on or before it is NOT requeued (Xero would only
    // reject it again): it is decided here, row by row, and warned about. With none known the original statements run.
    const lockedFailedIds: string[] = []
    if (lockDate) {
      const failedRows = await db.accountingSyncLog.findMany({
        where: { connector: XERO_CONNECTOR, type: { in: [...DAILY_BATCH_TYPES] }, status: 'FAILED' },
        select: { id: true, type: true, payload: true },
      })
      for (const row of failedRows) {
        const day = parseBatchDay((row.payload as { date?: string } | null)?.date)
        if (await skipJournalInLockedPeriod(`Failed daily batch journal ${String(row.type)} ${row.id}`, day, lockDate)) lockedFailedIds.push(row.id)
      }
    }
    await db.$transaction(async (tx) => {
      const failedLogs = await tx.accountingSyncLog.findMany({
        where: {
          connector: XERO_CONNECTOR,
          type: { in: [...DAILY_BATCH_TYPES] },
          status: 'FAILED',
          ...(lockedFailedIds.length > 0 ? { id: { notIn: lockedFailedIds } } : {}),
        },
        select: { referenceId: true },
      })

      await tx.accountingSyncLog.updateMany({
        where: {
          connector: XERO_CONNECTOR,
          type: { in: [...DAILY_BATCH_TYPES] },
          status: 'FAILED',
          ...(lockedFailedIds.length > 0 ? { id: { notIn: lockedFailedIds } } : {}),
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
    return
  }
  // Enforced: each row is decided on its own type and payload, and ONLY the rows decided not-SHADOW are reset. The write
  // is keyed on that decided set AND on the status still being FAILED (a compare-and-swap per row), so the set that is
  // reset is exactly the set that was decided; a row that fails after the read is left FAILED for the next run, to be
  // decided then, rather than reset undecided.
  await db.$transaction(async (tx) => {
    const failed = await tx.accountingSyncLog.findMany({
      where: {
        connector: XERO_CONNECTOR,
        type: { in: [...DAILY_BATCH_TYPES] },
        status: 'FAILED',
      },
      select: { id: true, type: true, referenceId: true, payload: true, createdAt: true },
    })
    // THE WRITER-SIDE CUT-OFF AT THE RE-QUEUE: a batch row queued before the live-from instant is not made claimable again (the claim
    // would refuse it, and it would cycle between FAILED and PENDING every run). The floor is read here, at the moment of the write, and
    // is also a clause of the write itself, so the set that is reset is exactly the set that passed it.
    const cutoffFloor = xeroCutoffFloor()
    const lockedEnforcedIds = new Set<string>()
    if (lockDate) {
      for (const log of failed) {
        const day = parseBatchDay((log.payload as { date?: string } | null)?.date)
        if (await skipJournalInLockedPeriod(`Failed daily batch journal ${String(log.type)} ${log.id}`, day, lockDate)) lockedEnforcedIds.add(log.id)
      }
    }
    const failedLogs = failed.filter((log) => xeroProducerSeamVerdict({ connector: XERO_CONNECTOR, type: String(log.type), payload: log.payload }).kind !== 'shadow'
      && xeroBeforeCutoffRefusal({ createdAt: log.createdAt, type: String(log.type) }) === null
      && !lockedEnforcedIds.has(log.id))

    await tx.accountingSyncLog.updateMany({
      where: { id: { in: failedLogs.map((log) => log.id) }, status: 'FAILED', ...xeroNotBeforeCutoffWhere(cutoffFloor) },
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
  /** Set when another run held the batch lock and this one did nothing, by design. */
  skipped?: boolean
  reason?: string
  // cogs-audit scjz.60.4: the rounding-residue (GL_BASE_PRECISION units) swept to the
  // rounding-difference account this run, or null when nothing was swept (balanced,
  // unavailable, material gap flagged, or no rounding account configured).
  inventoryReconciliationSwept?: number | null
  // khdw: same, for the COGS subledger-vs-GL rounding sweep.
  cogsReconciliationSwept?: number | null
  // 6oyu.4 (khdw): same, for the STOCK_IN_TRANSIT subledger-vs-GL rounding sweep.
  transitReconciliationSwept?: number | null
  /** GR/IR accrual: how many reclass journals this run staged (0 while `grir_xero_posting_enabled` is off, which is the default). */
  grirReclassJournals?: number
  /** GR/IR reclass journals the producer hold recorded as shadows this run (their source rows stay unconsumed). */
  grirReclassShadowed?: number
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
 * o3d-nepa: and "no row at all" is only trustworthy because RETENTION NO LONGER PRODUCES IT for the
 * rows this verdict blocks on. Deleting an unresolved abandoned row by age moved it out of the
 * BLOCKED-unproved arm and into ALLOWED — silently, and with no reader failing anywhere — so the
 * refusal below became a rebuild. Retention now keeps exactly the rows `cancelledClaimIsResolved`
 * calls unproved, and compacts their payload instead; the columns this function selects all survive.
 *
 * A row bearing an `externalTransactionId` blocks whatever its status says: that id exists only
 * because the remote call returned, so it is the ledger's own receipt and outranks any later
 * abandonment written over the top of it.
 *
 * ...UNLESS A PERSON TYPED IT (o3d-jit6 r2, Codex finding 2). The sentence above is true of an id the
 * CONNECTOR recorded, and false of one the per-row settlement action wrote: there, a human looked in
 * the ledger, typed a document id, and IMS accepted it without reading the document, checking which
 * organisation it belongs to, or comparing a single line of it. The row lands SYNCED all the same, and
 * SYNCED is the first entry in LIVE_DAILY_BATCH_STATUSES — so an assertion used to reach this reader
 * as an indistinguishable "the journal is in the ledger", and blocked the recreate SILENTLY, exactly
 * as a confirmed post does. That is o3d-anu8's defect (an operator assertion promoted into system
 * evidence) arriving through the settlement action, and o3d-nf9i's `settlementBasis` column is the
 * vocabulary for it.
 *
 * The BLOCK is right and stays — a recreate on top of a journal that really is there posts it twice,
 * and this reader must never move money on anything weaker than positive evidence. What changes is
 * that it stops being SILENT: an asserted row now returns a REFUSAL, which the caller surfaces on the
 * run, every run, until somebody confirms the journal. The two outcomes an operator has to be able to
 * tell apart are "this batch is in the accounts" and "this batch is BELIEVED to be in the accounts,
 * and if the belief is wrong its value is missing from them and nothing will ever raise it again".
 *
 * A connector-written SYNCED row has `settlementBasis` null and is unaffected: absence of an assertion
 * IS the confirmation case, and nothing is back-filled.
 *
 * `refs` is either a single derived `<group>-<date>` key (the reconciliation sweeps, whose identity
 * is `<PREFIX>-<date>` by construction and never persisted) or a bucket's full set of candidate
 * referenceIds. Every candidate is ORed together, and a bucket with NO candidates at all is blocked
 * rather than recreated blind.
 */
type DailyBatchRecreateVerdict = { blocked: boolean; refusal: string | null }

/** Codex round 17: the refusal for a daily batch whose cancelled/failed row was settled BY HAND as posted. Pure, so the operator wording is rendered by the tests. */
export function dailyBatchAssertedRefusal(type: string, describeAsserted: string): string {
  return withLedgerCheck(`Daily batch ${type} not recreated: ${describeAsserted} — that row was settled BY HAND as ` +
        '"it DID post". The document id on it is what an operator typed after looking in the accounting ' +
        'system; IMS did not verify the document, which organisation holds it or its lines.' +
        ' The batch is deliberately NOT recreated, because if the journal really is ' +
        'there a rebuild posts it twice — but nothing has confirmed that it is. Open that document in ' +
        'the accounting system and check it covers this batch. If it does not exist, this batch\'s ' +
        'value is missing from the accounts and no sweep will ever raise it again: post it there from ' +
        'the row\'s own lines and correct the id.')
}

/** Codex round 17: the refusal for a daily batch with cancelled/failed rows that do not prove the journal never reached the ledger. Pure, so the tests render it. */
export function dailyBatchUnprovedRefusal(type: string, describe: string): string {
  return withLedgerCheck(
    `Daily batch ${type} not recreated: ${describe} — ` +
      'a cancelled or failed row does not establish that its journal never reached the ledger ' +
      '(the processor posts before it persists SYNCED), so re-raising it could post the same ' +
      'journal twice. Check the accounting system for a journal covering this batch first: if one is there, settle the row with its id; ' +
      'only if none is there, re-post it deliberately. Or leave it: the orders/shipments keep their stamps ' +
      'and the standing accounting invariants keep reporting them.',
  )
}

export async function dailyBatchRecreateVerdict(
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
    select: {
      id: true,
      referenceId: true,
      status: true,
      externalTransactionId: true,
      abandonedBeforeRemoteCall: true,
      // o3d-jit6 r2 #2: REQUIRED, not decorative. Dropping it would make every row arrive with
      // `settlementBasis` undefined, which `settlementBasisOf` reads as CONNECTOR_CONFIRMED — so a
      // forgotten column here silently restores the laundering rather than failing.
      settlementBasis: true,
    },
  })
  if (rows.length === 0) return { blocked: false, refusal: null }
  const live = rows.filter((row) => LIVE_DAILY_BATCH_STATUSES.includes(row.status as typeof LIVE_DAILY_BATCH_STATUSES[number]))
  if (live.length > 0) {
    const asserted = live.filter((row) => isOperatorAssertedSettlement(row.settlementBasis))
    // Worst-first: one asserted row among the live ones is enough to make the whole block rest on an
    // assertion, because the batch is one journal and it is that row that claims to be it.
    if (asserted.length === 0) return { blocked: true, refusal: null }
    const describeAsserted = asserted
      .map((row) => `${row.referenceId} (${row.id}, ${row.status}${row.externalTransactionId ? `, external id ${row.externalTransactionId}` : ''})`)
      .join(', ')
    return {
      blocked: true,
      refusal:
        dailyBatchAssertedRefusal(type, describeAsserted),
    }
  }
  // Read from the SHARED rule, not restated (o3d-nepa). Retention's delete predicate asks the same
  // question of the same columns — "is this cancelled row's abandonment resolved?" — and it is
  // this reader's `rows.length === 0` arm that a wrong answer there turns into a duplicate journal.
  // Two spellings of one rule is how that hole reopens silently.
  //
  // The rule's OPERATOR-ASSERTION arm (round 4) is unreachable from here and must stay so:
  // `isSettleableAccountingSyncType` refuses DAILY_BATCH_* at every status, so no row this function
  // ever reads can carry `settlementBasis = OPERATOR_ASSERTION`. The column is selected anyway,
  // because handing a shared rule a row with the field missing is how a silent `undefined` becomes
  // a verdict.
  const unprovedOrShadow = rows.filter((row) => !cancelledClaimIsResolved(row))
  if (unprovedOrShadow.length === 0) return { blocked: false, refusal: null }
  // A SHADOW is the producer-side hold's record of this very batch: IMS did not send it and a rebuild must not happen over it (it blocks),
  // but it is not "a cancelled or failed row that might have posted by mistake", and there is nothing for an operator to settle or re-post: the
  // refusal's remedy would have them duplicate the owner's journal. It blocks quietly; any OTHER unproved row still gets the refusal.
  const unproved = unprovedOrShadow.filter((row) => !isShadowedObligation(row))
  if (unproved.length === 0) return { blocked: true, refusal: null }
  const describe = unproved
    .map((row) => `${row.referenceId} (${row.id}, ${row.status}${row.externalTransactionId ? `, external id ${row.externalTransactionId}` : ''})`)
    .join(', ')
  return {
    blocked: true,
    refusal:
      dailyBatchUnprovedRefusal(type, describe),
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
export async function recreateMissingDailyBatchLogs(
  settings: Awaited<ReturnType<typeof getXeroSettings>>,
  baseCurrency: string,
  // o3d-sidy: where a negative-basis refusal is also recorded, so the run can report it by name.
  negativeBasisRefusals?: NegativeCostBasisRefusal[],
  // ACC-H11: nothing dated on or before the Xero books lock date is rebuilt (see skipJournalInLockedPeriod).
  lockDate: string | null = null,
): Promise<string[]> {
  const refusals: string[] = []
  // scjz.36: only recreate within the sync-log retention window — beyond it, SYNCED
  // daily-batch logs are pruned by data-retention, so a "missing" log can't be told
  // apart from one that already posted, and rebuilding would double-post the journal.
  // o3d-i0o6 r7: the cutoff as well as the filter. The filter bounds which ORDERS are read;
  // the cutoff bounds which of the batches their pass histories name may be rebuilt.
  // THE WRITER-SIDE CUT-OFF: a batch dated before Xero's live-from instant is not this sweep's to rebuild (see clampRecreateWindowToCutoff).
  const { cutoff: retentionCutoff, dateFilter: journaledDateFilter } = clampRecreateWindowToCutoff(await recreateRetentionWindow(), xeroCutoffFloor())
  const orphanA1Orders = await db.salesOrder.findMany({
    where: { revenueDeferredDate: journaledDateFilter },
    select: {
      revenueDeferredDate: true,
      revenueDeferredBatchRef: true,
      unearnedRevenueAmount: true,
      // ACC-H13: the paid-day journal carries the GROSS deferral; pre-batch refunds are separate adjustment
      // journals. The stored amount is net, so the refunds that were netted are added back here.
      refunds: { select: { id: true, totalBase: true, totalsBasis: true, refundedAt: true, deferralAdjustmentRef: true } },
      // ACC-H12: the revenue shipments recognised before the deferral, which the paid-day journal leaves out. Such an
      // order is rebuilt from its gross figure (see below), so the inputs of that figure ride along.
      shipments: { where: { cogsRelievedFromInventoryAt: { not: null } }, select: { revenueRecognizedAmount: true } },
      subtotalBase: true,
      shippingBase: true,
      discountAmount: true,
      pricesIncludeVat: true,
      taxRatePercent: true,
      fxRateToBase: true,
      shoppingLinks: { select: { connector: true } },
      lines: { select: { totalBase: true, taxRate: { select: { rate: true } } } },
    },
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
    select: {
      id: true,
      orderNumber: true,
      inventoryAllocatedDate: true,
      inventoryAllocatedBatchRef: true,
      allocationBatchAmount: true,
      // o3d-i0o6 r4: the pass history is what divides a CUMULATIVE debit between the batches that
      // carried it. Without it this sweep can only read the running total, and a batch rebuilt from
      // the running total re-posts every earlier batch's pounds (see allocationDebitShareOfBatch).
      allocationBatchPasses: true,
    },
  })
  const orphanBShipments = await db.shipment.findMany({
    where: { shipmentJournalDate: journaledDateFilter },
    select: { id: true, shipmentJournalDate: true, shipmentJournalBatchRef: true, revenueRecognizedAmount: true, cogsBatchAmount: true, cogsRelievedFromInventoryAt: true, cogsRelievedFromInventoryAmount: true },
  })

  const adjustmentBatches = new Map<string, DailyBatchRecreateBucket<{ refundCount: number; total: number }>>()
  // ACC-H13: the pre-batch refund adjustment journals, each identified by the ref stamped on its refunds and read
  // from the same orders (same retention window and cut-off) as the paid-day batches, so a lost adjustment is
  // rebuilt exactly once.
  for (const order of orphanA1Orders) {
    // ACC-H12: with revenue shipped before payment only the deferred part of a refund was adjusted against Unearned.
    const shippedBeforeDeferral = (order.shipments ?? []).reduce((sum, shipment) => sum + Number(shipment.revenueRecognizedAmount ?? 0), 0)
    const deferredPartByRefundId = shippedBeforeDeferral > 0
      ? new Map(preBatchRefundDeferredParts(order.refunds, revenueDeferralGrossAmount({ id: '', ...order }), shippedBeforeDeferral).map((part) => [part.refundId, part.deferredPart]))
      : null
    for (const refund of order.refunds ?? []) {
      if (!refund.deferralAdjustmentRef) continue
      const summary = foldDailyBatchRow(
        adjustmentBatches,
        'A1',
        { stagedAt: order.revenueDeferredDate, persistedRef: refund.deferralAdjustmentRef },
        () => ({ refundCount: 0, total: 0 }),
      )
      if (!summary) continue
      summary.refundCount += 1
      summary.total += deferredPartByRefundId ? (deferredPartByRefundId.get(refund.id) ?? 0) : Number(refund.totalBase ?? 0)
    }
  }

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
    const nettedBack = preBatchRefundsNettedIntoStoredDeferral(order)
    const shippedBeforeDeferral = (order.shipments ?? []).reduce((sum, shipment) => sum + Number(shipment.revenueRecognizedAmount ?? 0), 0)
    // ACC-H12: the paid-day journal of an order with revenue shipped before payment is its gross deferral less that
    // revenue, whatever refunds were netted or not (the stored figure then also carries refunds of shipped goods).
    summary.total += shippedBeforeDeferral > 0
      ? Math.max(0, revenueDeferralGrossAmount({ id: '', ...order }) - shippedBeforeDeferral)
      : Number(order.unearnedRevenueAmount ?? 0) + nettedBack
  }

  // o3d-i0o6 r5 (Codex round 4, HIGH 1) — THE LEDGER THIS SWEEP WOULD POST INTO, NAMED ONCE.
  // The live-log probe below already filters by `connector`, so a batch that posted on QuickBooks
  // is invisible to this sweep and reads as missing; without the same filter on the EVIDENCE, the
  // rebuild carried QuickBooks-attributed pounds into Xero accounts.
  const a2Ledger: AllocationDebitBatchLedger = {
    connector: XERO_CONNECTOR,
    accountCode: settings.xero_allocated_inventory_account,
  }
  const a2Batches = new Map<string, DailyBatchRecreateBucket<A2RecreateSummary>>()
  for (const order of orphanA2Orders) {
    // o3d-i0o6 r7 (Codex round 6, HIGH 2) — ONE BUCKET PER BATCH THIS ORDER PUT POUNDS INTO, read
    // from the PASS HISTORY. Bucketing on `inventoryAllocatedBatchRef` alone made the latest pass
    // stand for the whole debit again: an earlier batch whose journal went missing existed in no
    // bucket, so no sweep rebuilt it and no sweep reported it either.
    for (const target of allocationDebitRecreateTargets(order, { retentionCutoff })) {
      const summary = foldDailyBatchRow(
        a2Batches,
        'A2',
        { stagedAt: target.stagedAt, persistedRef: target.batchRef },
        newA2RecreateSummary,
      )
      if (!summary) continue
      // o3d-i0o6 r4 (Codex round 3, HIGH 1) — THIS BATCH'S SHARE, NEVER THE RUNNING TOTAL, and
      // (r5) never another ledger's share of it either. One shared fold, so the Xero and QuickBooks
      // sweeps cannot answer the same question two ways.
      foldA2RecreateOrder(summary, order, a2Ledger, target.batchRef)
    }
  }

  const bBatches = new Map<string, DailyBatchRecreateBucket<{ shipmentCount: number; revenue: number; cogs: number; inventoryCogs: number; shipments: Array<{ id: string; cogs: number }> }>>()
  for (const shipment of orphanBShipments) {
    const summary = foldDailyBatchRow(
      bBatches,
      'B',
      { stagedAt: shipment.shipmentJournalDate, persistedRef: shipment.shipmentJournalBatchRef },
      () => ({ shipmentCount: 0, revenue: 0, cogs: 0, inventoryCogs: 0, shipments: [] }),
    )
    if (!summary) continue
    // ACC-H12: a shipment costed straight out of Inventory is rebuilt at the amount that journal ORIGINALLY posted, which
    // is recorded once and never revalued. `cogsBatchAmount` is rewritten in place by landed-cost revaluation, which
    // posts its own correction separately, so using it here would count that correction twice.
    const shipmentCogs = shipment.cogsRelievedFromInventoryAt && shipment.cogsRelievedFromInventoryAmount != null
      ? Number(shipment.cogsRelievedFromInventoryAmount)
      : Number(shipment.cogsBatchAmount ?? 0)
    summary.shipmentCount += 1
    // ACC-H12: a shipment costed straight out of Inventory recorded its revenue share but posted no revenue leg
    // (the invoice booked it), and its COGS credit went to Inventory rather than Allocated Inventory.
    if (shipment.cogsRelievedFromInventoryAt) summary.inventoryCogs += shipmentCogs
    else summary.revenue += Number(shipment.revenueRecognizedAmount ?? 0)
    summary.cogs += shipmentCogs
    // bcz9.3: carry the per-shipment list so the recreate path can write the same
    // per-shipment DISPATCH ledger rows the live dispatch path writes.
    summary.shipments.push({ id: shipment.id, cogs: shipmentCogs })
  }

  for (const { referenceId, date, summary, ...batch } of a1Batches.values()) {
    if (summary.total <= 0) continue
    if (await skipJournalInLockedPeriod(`Missing revenue deferral batch ${referenceId}`, date, lockDate)) continue
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

  for (const { referenceId, date, summary, ...batch } of adjustmentBatches.values()) {
    if (round2(summary.total) <= 0) continue
    if (await skipJournalInLockedPeriod(`Missing refund deferral adjustment batch ${referenceId}`, date, lockDate)) continue
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
          reference: `Revenue Deferral refund adjustment ${date}`,
          narration: `Recreated revenue deferral adjustment: ${summary.refundCount} refund(s), £${round2(summary.total).toFixed(2)}`,
          lines: [
            { accountCode: settings.xero_unearned_revenue_account, description: `Pre-batch refund adjustment — ${summary.refundCount} refund(s)`, debit: round2(summary.total) },
            { accountCode: settings.xero_sales_account, description: `Pre-batch refund adjustment — ${summary.refundCount} refund(s)`, credit: round2(summary.total) },
          ],
          _postingMode: 'submitted',
          _recreatedFromStage: true,
        },
      })
    })
  }

  // o3d-i0o6 r6 (Codex round 5, HIGH 1) — WHO, IF ANYONE, IS COMING FOR THE OTHER LEDGER'S POUNDS.
  //
  // r5 stopped this sweep rebuilding another connector's share of a shared batch reference, which
  // was right, and then reported the share it had declined as a positive £0.00, which was not: the
  // cron runs ONE sweep, so after a switch the other connector's sweep never runs and its missing
  // journal has no reader left. Two reads settle it, and only for batches that actually have a
  // foreign pass, so the ordinary run makes no extra query:
  //
  //   * is that pass's own journal still a live row? (BY ID, with no connector filter — the question
  //     is about the OTHER ledger's row, and this sweep's own probes deliberately exclude it.)
  //   * is that ledger's sweep the one the cron runs? — from the schedule the cron route itself reads.
  const foreignPasses = [...a2Batches.values()].flatMap((bucket) => bucket.summary.foreign)
  // o3d-i0o6 r7 (Codex round 6, MEDIUM) — EVERY STATUS, NOT JUST THE LIVE THREE. The probe used to
  // filter `status in (PENDING, PROCESSING, SYNCED)`, so a FAILED or CANCELLED row came back exactly
  // like a deleted one and the report told an operator the journal was not on record and to post it
  // by hand. Neither status establishes that nothing reached the remote ledger, so that advice can
  // duplicate a posting. The status is carried instead, and the report distinguishes the two.
  const foreignJournalRowById = new Map<string, LedgerStandingRow>()
  let scheduledSweepConnector: string | null = null
  if (foreignPasses.length > 0) {
    scheduledSweepConnector = (await resolveScheduledDailyBatchSweep()).connector
    const foreignJournalIds = [...new Set(foreignPasses.map((pass) => pass.syncLogId).filter((id): id is string => !!id))]
    if (foreignJournalIds.length > 0) {
      const rows = await db.accountingSyncLog.findMany({
        where: { id: { in: foreignJournalIds } },
        // o3d-1e7sl (G15): the standing columns, because an operator-typed SYNCED journal is `asserted`, not
        // `live` - it still counts as existing (D2) but is reported.
        select: { id: true, ...LEDGER_STANDING_SELECT },
      })
      for (const row of rows) foreignJournalRowById.set(row.id, row)
    }
  }
  const foreignJournalState = (syncLogId: string | null): ForeignJournalState => {
    // A pass that named no journal raised none: unambiguously nothing in the other ledger.
    if (syncLogId == null) return 'absent'
    return foreignJournalStateOf(foreignJournalRowById.get(syncLogId))
  }

  for (const { referenceId, date, summary, ...batch } of a2Batches.values()) {
    // o3d-i0o6 r6: reported BEFORE every skip below, because none of them is about these pounds. A
    // batch whose own log is live, or whose own share rounds to zero, can still carry a foreign pass
    // nobody will ever raise — and those are exactly the runs that would otherwise `continue` past it.
    refusals.push(...allocationDebitForeignLedgerReports({
      referenceId,
      foreign: summary.foreign,
      journalState: foreignJournalState,
      scheduledSweepConnector,
    }))
    // ROUNDED, like the live writer's own `totalAllocatedValueNumber > 0` guard: a batch whose total
    // rounds to £0.00 raised no journal when it ran and must raise none now (o3d-i0o6 r4). The
    // unattributed arm is still reached at zero, because a batch nothing can value is not a batch
    // known to be worth nothing.
    if (round2(summary.total) <= 0 && summary.unattributed.length === 0) continue
    if (await skipJournalInLockedPeriod(`Missing inventory allocation batch ${referenceId}`, date, lockDate)) continue
    const verdict = await dailyBatchRecreateVerdict('DAILY_BATCH_INVENTORY_ALLOC', dailyBatchLiveRefs(batch))
    if (verdict.blocked) {
      if (verdict.refusal) refusals.push(verdict.refusal)
      continue
    }
    // The batch's log really is missing AND at least one of its orders cannot say what it put into
    // it. Reported, not skipped: this is the outcome a human has to resolve.
    if (summary.unattributed.length > 0) {
      refusals.push(allocationDebitRecreateRefusal(referenceId, summary.unattributed))
      continue
    }
    if (round2(summary.total) <= 0) continue
    await db.$transaction(async (tx) => {
      const recreatedLogId = await createPendingSyncLog(tx, {
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
      // o3d-i0o6 r5 (Codex round 4, HIGH 2) — AND THE EVIDENCE MOVES WITH THE JOURNAL. The passes
      // that put these pounds into this batch name the log that went missing; left alone, every
      // later refund and orphan reversal resolves that dead id, refuses, and the recreated debit
      // can never be credited back out. Re-pointed in the SAME transaction as the create, so a row
      // can never name a journal this sweep replaced but did not record.
      for (const order of summary.orders) {
        const repointed = repointAllocationDebitPassesToRecreatedJournal({
          existingPasses: order.allocationBatchPasses,
          batchRef: order.batchRef,
          ledger: a2Ledger,
          syncLogId: recreatedLogId,
        })
        if (!repointed) continue
        await tx.salesOrder.update({
          where: { id: order.id },
          // Every column spelled out, not spread from the helper's return: o3d-psrx's write census
          // resolves this literal to check no writer sets `paidAt` without its provenance, and a
          // `data` it cannot read is a hole in that census rather than a pass.
          data: {
            allocationBatchPasses: repointed.allocationBatchPasses,
            ...(repointed.latestPass ? {
              allocationBatchSyncLogId: repointed.latestPass.syncLogId,
              allocationBatchConnector: repointed.latestPass.connector,
              allocationBatchAccountCode: repointed.latestPass.accountCode,
            } : {}),
          },
        })
      }
    })
  }

  for (const { referenceId, date, summary, ...batch } of bBatches.values()) {
    // o3d-sidy (review M2): the rebuild values each shipment at its LIVE cogsBatchAmount, which a
    // landed-cost revaluation rewrites — so a revalued negative would be rebuilt revenue-only under
    // the `> 0` gate below and written to the subledger as a negative dispatch.
    //
    // o3d-sidy r2 (HIGH): and ONLY for a batch that is actually lost. The revaluation rewrites
    // cogsBatchAmount on journaled shipments whose journal is perfectly live (the o3d-c08y path), so
    // judging the sign before the verdict refused LIVE batches every run and told the operator a
    // posted journal was lost and would be rebuilt — the invitation to re-post it that o3d-o97 r6
    // removed. So: the empty-batch skip spares a batch holding a negative (its only content may be
    // that negative), the verdict decides whether there is anything to rebuild at all, and only then
    // is a negative refused.
    //
    // PER SHIPMENT TOTAL, not per entry: the sweep reads cogsBatchAmount, not the snapshots, so a
    // shipment whose entries net positive is rebuilt at its netted total. Only a negative TOTAL is
    // refused here; the per-entry refusal is Group B's, before the journal was ever written.
    const negativeShipments = summary.shipments.filter((shipment) => shipment.cogs < 0)
    if (summary.revenue <= 0 && summary.cogs <= 0 && negativeShipments.length === 0) continue
    if (await skipJournalInLockedPeriod(`Missing shipment batch ${referenceId}`, date, lockDate)) continue
    const verdict = await dailyBatchRecreateVerdict('DAILY_BATCH_GROUP_B', dailyBatchLiveRefs(batch))
    if (verdict.blocked) {
      if (verdict.refusal) refusals.push(verdict.refusal)
      continue
    }
    if (negativeShipments.length > 0) {
      const named = negativeShipments.map((shipment) => `${shipment.id} (COGS ${round2(shipment.cogs).toFixed(2)})`).join(', ')
      const refusal = new NegativeCostBasisRefusal(
        `Daily batch DAILY_BATCH_GROUP_B not recreated: ${referenceId} — its journal is missing, and shipment(s) `
        + `${named} carry a negative cost basis, so rebuilding would post it revenue-only. `
        + `${NEGATIVE_BASIS_REMEDY}sweep rebuilds it (o3d-sidy).`,
        {
          group: 'B_RECREATE', orderId: null, orderRef: null, shipmentId: negativeShipments[0].id, batchRef: referenceId,
          negativeEntries: [], value: round2(summary.cogs).toFixed(2),
        },
      )
      refusals.push(refusal.message)
      negativeBasisRefusals?.push(refusal)
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
      const inventoryCredit = Math.min(round2(summary.inventoryCogs), round2(summary.cogs))
      const allocatedCredit = round2(round2(summary.cogs) - inventoryCredit)
      lines.push({ accountCode: settings.xero_cogs_account, description: `COGS — ${summary.shipmentCount} shipment(s)`, debit: round2(summary.cogs) })
      if (allocatedCredit > 0) lines.push({ accountCode: settings.xero_allocated_inventory_account, description: `COGS — ${summary.shipmentCount} shipment(s)`, credit: allocatedCredit })
      if (inventoryCredit > 0) lines.push({ accountCode: settings.xero_inventory_account, description: `COGS shipped before payment — ${summary.shipmentCount} shipment(s)`, credit: inventoryCredit })
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

/**
 * o3d-sidy (P1) — THE DAILY BATCH REFUSES A NEGATIVE COST BASIS BY NAME, IN EVERY PLACE IT VALUES ONE.
 *
 * WHAT HAPPENED WITHOUT THIS, proved end to end on scratch databases (o3d-sidy): a landed-cost recalc
 * applying a CREDIT freight cost line drove a cost layer negative, and
 * `updateSnapshotsForCostLayerChange` rewrote already-shipped and allocated snapshots to that
 * negative unit cost in place — with no movement builder in the path, so neither negative-basis
 * refusal (#683, transfer re-layering) saw it. The batch then took it in three places, each gated on
 * a `> 0` total that turns a negative into SILENCE:
 *
 *   • GROUP B journaled the shipment with its revenue pair only (its narration said "COGS £-6.00"),
 *     stamped it, and wrote a COGS subledger dispatch the ledger never received;
 *   • GROUP A2 valued the dispatched units at the negative cost and debited Allocated Inventory short
 *     (£14 for a £24 batch, found by the independent review), stamped the order with the negative
 *     amount — so the correction that followed, which re-values the layer, left Allocated Inventory
 *     understated and Inventory overstated permanently;
 *   • the GROUP B RECREATE SWEEP rebuilt a lost journal from a revalued negative cogsBatchAmount
 *     revenue-only, writing a negative DISPATCH row.
 *
 * Beside healthy rows the same negative was NETTED into the total instead, understating it just as
 * silently.
 *
 * WHY REFUSE RATHER THAN POST SIGNED. A reversed pair is how a signed amount would be represented,
 * and whether IMS represents a negative basis at all is the deferred o3d-gd2f decision
 * (docs/todo/negative-basis-cost-layers-decision.md catalogues every path that can carry one; this
 * change covers the three above, not the rest of that list). Until it is taken, the established
 * answer is to refuse where an operator can see it (#683, transfer-cost-layer-recreation.ts).
 *
 * WHY NOT A FAILED SYNC ROW. `resetFailedDailyBatchLogs` returns every FAILED daily-batch row to
 * PENDING at the start of the next run, so a FAILED row would be re-queued for posting — the opposite
 * of a refusal — and in A2 and Group B there is no journal to attach one to.
 *
 * PER ENTRY, NOT PER TOTAL. `parseCostLayerSnapshot` drops non-positive quantities, so an entry values
 * below zero exactly when its unit cost does; a row that nets positive still carries the basis IMS
 * does not represent. A ZERO basis is not refused: free goods cost nothing, and a `> 0` gate dropping
 * a zero pair drops nothing.
 *
 * HOW AN OPERATOR LEARNS OF IT. Each refusal is (1) an ERROR entry in the activity log
 * against the sales order — or, for the recreate sweep, the batch — naming the shipment and the
 * layers, and (2) an entry at the FRONT of the run's errors, which fails the cron run with it as the
 * reason (CronRun.statusReason keeps 500 characters, so the refusals go first rather than behind the
 * recreate sweep's own messages).
 */
export class NegativeCostBasisRefusal extends Error {
  constructor(
    message: string,
    readonly detail: {
      group: 'A2' | 'B' | 'B_RECREATE'
      orderId: string | null
      orderRef: string | null
      shipmentId: string | null
      batchRef: string | null
      negativeEntries: Array<{ costLayerId: string; qty: string; unitCostBase: string }>
      value: string
    },
  ) {
    super(message)
    this.name = 'NegativeCostBasisRefusal'
  }
}

/** The entries of a snapshot whose unit cost is below zero — what the batch refuses to post. */
function negativeBasisEntries(entries: CostLayerSnapshotEntry[]): CostLayerSnapshotEntry[] {
  return entries.filter((entry) => toDecimal(entry.unitCostBase).lt(0))
}

function describeNegativeEntries(entries: CostLayerSnapshotEntry[]): string {
  return entries.map((entry) => `${entry.costLayerId} (${toDecimal(entry.qty).toString()} @ ${toDecimal(entry.unitCostBase).toString()})`).join(', ')
}

function negativeEntryDetail(entries: CostLayerSnapshotEntry[]) {
  return entries.map((entry) => ({
    costLayerId: entry.costLayerId,
    qty: toDecimal(entry.qty).toString(),
    unitCostBase: toDecimal(entry.unitCostBase).toString(),
  }))
}

const NEGATIVE_BASIS_REMEDY = 'Correct the basis (usually a credit freight cost line a landed-cost recalculation '
  + 'applied to the purchase order) and the next batch '

/** Group B: refuse the shipment's ORDER when any entry it would post is negative. Thrown into the per-order catch. */
function refuseNegativeBasisShipmentCogs(
  order: { orderId: string; orderRef: string },
  shipmentId: string,
  entries: CostLayerSnapshotEntry[],
): void {
  const negative = negativeBasisEntries(entries)
  if (negative.length === 0) return
  const cogs = roundQuantity(sumCostLayerSnapshot(entries), 2)
  throw new NegativeCostBasisRefusal(
    `Group B order ${order.orderRef}: negative cost basis on shipment ${shipmentId} — cost layer(s) `
    + `${describeNegativeEntries(negative)}; COGS would be ${cogs.toFixed(2)}. Not journaled; it stays `
    + `queued. ${NEGATIVE_BASIS_REMEDY}posts it (o3d-sidy).`,
    {
      group: 'B', orderId: order.orderId, orderRef: order.orderRef, shipmentId, batchRef: null,
      negativeEntries: negativeEntryDetail(negative), value: cogs.toFixed(2),
    },
  )
}

/** The lock reaches today, so a group stages nothing this run: say so, actionably, in the activity log. */
async function reportLockBlocksRun(group: 'A1' | 'A2' | 'B' | 'GR/IR', lockDate: string | null): Promise<void> {
  if (!lockDate) return
  await logActivity({
    entityType: 'SYSTEM',
    action: 'daily_batch_blocked_by_lock_date',
    tag: 'sync',
    level: 'WARNING',
    description: lockBlocksRunMessage(group, lockDate),
    metadata: { group, lockDate },
    resolveUser: false,
  }).catch(() => { /* a report that cannot be written must not change what the batch did */ })
}

/**
 * ACC-H11: say so when a journal was moved out of a locked period. Logged only AFTER the transaction that
 * staged the journal committed, so a rolled-back run does not report a move that never happened. A failed
 * log write must never change what the batch did.
 */
async function reportLockedPeriodMoves(
  group: 'A1' | 'A2' | 'B' | 'GR/IR',
  journalDate: string,
  movedFromLockedDays: readonly string[],
  lockDate: string | null,
): Promise<void> {
  if (movedFromLockedDays.length === 0) return
  await logActivity({
    entityType: 'SYSTEM',
    action: 'daily_batch_locked_period_event_moved',
    tag: 'sync',
    level: 'WARNING',
    description: `Daily batch group ${group}: event date(s) ${[...movedFromLockedDays].sort().join(', ')} fall in a locked period (locked through ${lockDate ?? 'unknown'}), so the journal was dated ${journalDate}, the first open day, instead of being back-dated.`,
    metadata: { group, journalDate, movedFromLockedDays: [...movedFromLockedDays].sort(), lockDate },
    resolveUser: false,
  }).catch(() => { /* a report that cannot be written must not change what the batch posted */ })
}

/** Put this run's negative-basis refusals where an operator will see them. See NegativeCostBasisRefusal. */
async function reportNegativeBasisRefusals(
  result: XeroDailyBatchResult,
  refusals: NegativeCostBasisRefusal[],
): Promise<void> {
  if (refusals.length === 0) return
  const messages = refusals.map((refusal) => refusal.message)
  result.errors = [...messages, ...result.errors.filter((error) => !messages.includes(error))]
  for (const refusal of refusals) {
    await logActivity({
      entityType: refusal.detail.orderId ? 'SALES_ORDER' : 'SYSTEM',
      entityId: refusal.detail.orderId ?? refusal.detail.batchRef ?? null,
      action: 'daily_batch_negative_cost_basis_refused',
      tag: 'sync',
      level: 'ERROR',
      description: refusal.message,
      metadata: refusal.detail,
      resolveUser: false,
    })
  }
}

/**
 * GR/IR ACCRUAL: stage the daily reclass journal(s) of the GR/IR sub-ledger, only while `grir_xero_posting_enabled` is 'true'.
 *
 * OFF (the default) is the whole of the first line: nothing is read, staged or stamped, and the sub-ledger keeps accruing from the receipts and bills
 * that write it. ON, every sub-ledger row not yet consumed (`xeroBatchRef` null) is grouped by its resolved posting day (the same lock-date rule
 * every group follows: an event in a locked period is dated the first open day, and waits while the lock reaches today), netted per day, and staged as
 * one DAILY_BATCH_GRIR_RECLASS journal through the SAME producer seam as every other batch journal, so the hold applies: a SHADOW is recorded and
 * nothing is queued. The rows a day's journal was built from are stamped with its reference in the same transaction, so they are never consumed twice,
 * and, when the journal was actually queued, the transit sub-ledger records the Stock in Transit movement the journal makes (a shadow moves nothing in
 * the ledger, so it records nothing there). A failure never aborts the batch: the postings above already committed.
 */
async function stageGrirReclassJournals(
  settings: Awaited<ReturnType<typeof getXeroSettings>>,
  baseCurrency: string,
  context: { today: string; lockDate: string | null },
  batchLimit: number,
  result: XeroDailyBatchResult,
): Promise<void> {
  result.grirReclassJournals = 0
  if (settings.grir_xero_posting_enabled !== 'true') return
  try {
    const transitAccount = settings.xero_transit_account?.trim() ?? ''
    const grirAccount = settings.xero_grir_account?.trim() ?? ''
    if (!transitAccount || !grirAccount) {
      result.errors.push('GR/IR posting is switched on but the Stock in Transit account or the GR/IR account (setting xero_grir_account) is not mapped, so no GR/IR reclass journal was staged. Map both accounts, or switch GR/IR posting off.')
      return
    }
    if (lockBlocksRun(context)) {
      await reportLockBlocksRun('GR/IR', context.lockDate)
      return
    }
    const moves: Array<{ date: string; movedFromLockedDays: string[] }> = []
    await db.$transaction(async (tx) => {
      const window = takeDailyBatchWindow(await tx.grirSubledgerMovement.findMany({
        where: { sourceType: { in: [...GRIR_BALANCE_SOURCE_TYPES] }, xeroBatchRef: null },
        select: { id: true, baseDelta: true, journalDate: true },
        orderBy: [{ journalDate: 'asc' }, { id: 'asc' }],
        take: batchLimit + 1,
      }), batchLimit)
      if (window.rows.length === 0) return
      const dated = groupByPostingDate(window.rows, (row) => businessDay(row.journalDate), context)
      for (const group of dated.groups) {
        const referenceId = buildGrirReclassReferenceId(group.date, group.rows.map((row) => row.id))
        const journal = buildGrirReclassJournal({
          net: netGrirMovements(group.rows),
          rowCount: group.rows.length,
          transitAccount,
          grirAccount,
          lockedPeriodNote: lockedPeriodNarration(group.movedFromLockedDays, context.lockDate),
        })
        if (journal) {
          const staged = { queued: false }
          await createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_GRIR_RECLASS',
            referenceId,
            currency: baseCurrency,
            payload: {
              date: group.date,
              reference: `GR/IR reclass ${group.date} ${referenceId.slice(-8)}`,
              narration: journal.narration,
              lines: journal.lines,
              batchReferenceId: referenceId,
              batchDate: group.date,
              batchGroup: 'GRIR_RECLASS',
              batchEntityCount: group.rows.length,
              _postingMode: 'submitted',
            },
          }, staged)
          // A shadow is never posted by IMS: the ledger did not move, so the transit sub-ledger must not claim it did, and the rows the journal was
          // built from are NOT consumed. Unlike A2 and Group B (which stamp their source rows with the shadow's id), a GR/IR movement is the only
          // record of its accrual: nothing re-derives it, so consuming it into a shadow would lose it for good when the hold is lifted. The shadow is
          // recorded again (same batch reference while the rows are unchanged) and the rows post on the first run after the hold is lifted.
          if (!staged.queued) {
            result.grirReclassShadowed = (result.grirReclassShadowed ?? 0) + 1
            continue
          }
          await recordTransitSubledgerMovement(tx, {
            sourceType: 'GRIR_RECLASS',
            sourceRef: referenceId,
            idempotencyKey: `grir-reclass:${referenceId}`,
            baseDelta: journal.transitDelta,
            journalDate: group.date,
          })
          result.grirReclassJournals = (result.grirReclassJournals ?? 0) + 1
        }
        await tx.grirSubledgerMovement.updateMany({
          where: { id: { in: group.rows.map((row) => row.id) }, xeroBatchRef: null },
          data: { xeroBatchRef: referenceId },
        })
        moves.push({ date: group.date, movedFromLockedDays: group.movedFromLockedDays })
      }
    })
    // Reported only AFTER the transaction committed, so a rolled-back run does not report a move that never happened.
    for (const move of moves) await reportLockedPeriodMoves('GR/IR', move.date, move.movedFromLockedDays, context.lockDate)
  } catch (e) {
    result.errors.push(`GR/IR reclass error: ${String(e)}`)
  }
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
  // o3d-sidy: every negative-basis refusal this run makes, from A2, Group B and the recreate sweep.
  const negativeBasisRefusals: NegativeCostBasisRefusal[] = []
  // o3d-4ajo: pinned to ONE connection. Taking this through Prisma and releasing
  // it through Prisma can hit different pooled sockets, so the unlock silently
  // no-ops and the lock leaks — and this key is shared with refund creation /
  // the Xero payment jobs, so a leak stalls those too, not just the batch.
  const batchLock = await acquirePinnedAdvisoryLockOrNull(XERO_DAILY_BATCH_LOCK_KEY)
  if (!batchLock) {
    // By design, not a failure: another run holds the batch lock, so this tick does nothing and the next one carries on.
    return { ...result, skipped: true, reason: 'already-running' }
  }

  try {
    const settings = await getXeroSettings()
    const baseCurrency = await getBaseCurrencyCode()
    // The run's day is the BUSINESS day, like the paid days it is compared with (an event day after the run's date is clamped to it).
    const today = businessDateYmd(new Date())
    // ACC-H11: journals are dated by their EVENT, not by the run. `lockDate` is the operator-declared last
    // locked day in Xero (empty = none); an event on or before it is dated the first open day instead of
    // being back-dated into the locked period. See lib/domain/accounting/daily-batch-event-date.ts.
    // Imported from Xero's Organisation endpoint at the start of every run (read-only; falls back to the last
    // stored value, then to none, and never blocks the batch).
    const lockDate = (await refreshXeroBooksLockDate(settings.xero_books_lock_date)).lockDate
    const dateContext = { today, lockDate }
    // The lock reaches today: there is no open day to date a journal on, so NOTHING is staged this run (the
    // events wait and are picked up once the lock moves or the period opens).
    const lockBlocked = lockBlocksRun(dateContext)


    if (settings.xero_sync_enabled !== 'true') {
      return result
    }

    await resetFailedDailyBatchLogs(lockDate)
    // o3d-o97 r6: a batch the sweep REFUSED to rebuild (its only log is cancelled, which does not
    // establish that the journal never reached the ledger) is reported on the run rather than
    // skipped silently — it is the one outcome where a human has to decide whether to re-post.
    result.errors.push(...await recreateMissingDailyBatchLogs(settings, baseCurrency, negativeBasisRefusals, lockDate))

  // --- Group B: Shipment Revenue Recognition + COGS ---
  //
  // ACC-H12: RUN IN TWO PASSES, THE DIRECT ONE FIRST. A shipment that left while its order was not yet deferred is
  // costed straight out of Inventory (DR COGS / CR Inventory) on the day it shipped. That decision must not depend on
  // whether payment, Group A1 and Group A2 happened to run first: if A1 and A2 ran before it, the order would be
  // stamped, the shipment would take the ordinary path, A2 would reclassify its units through Allocated Inventory and
  // its COGS would be dated at the payment day. So the direct pass runs BEFORE A1 and A2, while the deferral stamp still
  // says what the order's state was when the goods left. A2 and A1 then see the marker and skip or net the costed units,
  // and Allocated Inventory nets to zero. The ordinary pass (paid, deferred, allocated) stays after A2 as before.
  const runGroupB = async (mode: 'direct' | 'paid'): Promise<void> => {
  groupBSkip: try {
    // o3d-4ajo: Postgres frees a session lock the instant its connection dies,
    // so from that moment another batch — or a refund, which shares this domain
    // — can start while we are still writing. Stop instead.
    batchLock.assertHeld('Group B (shipment revenue + COGS)')
    if (lockBlocked) {
      if (mode === 'paid') await reportLockBlocksRun('B', lockDate)
      break groupBSkip
    }
    const bPostedGroups: Array<{ date: string; movedFromLockedDays: string[] }> = []
    const groupBCount = await db.$transaction(async (tx) => {
      // o3d-c08y r2 (Codex HIGH): PROBE -> LOCK -> READ. This window's ids are read first, every cost
      // layer their data references is locked, and only then is the data itself read — under those
      // locks. Reading the snapshots first and locking afterwards let a landed-cost revaluation commit
      // a negative basis in between and be posted from the stale positive copy (measured; see
      // lib/domain/accounting/daily-batch-group-b-lock.ts). The same read also REVALIDATES status: a
      // shipment that stopped qualifying while we waited for the lock is simply not returned.
      const candidateWindow = takeDailyBatchWindow(await tx.shipment.findMany({
        where: groupBShipmentWhere(mode),
        select: { id: true, orderId: true, createdAt: true, shippedAt: true, order: { select: { revenueDeferredDate: true, paidAt: true } }, lines: { select: { costLayerSnapshot: true } } },
        orderBy: { createdAt: 'asc' },
        take: batchLimit + 1,
      }), batchLimit)
      result.hasMore.groupB = result.hasMore.groupB || candidateWindow.hasMore
      // The where-clause already splits the passes by the order's deferral stamp; restating it on the probe rows means a pass
      // with nothing of its own takes no lock and reads nothing (the stamp is only written by Group A1, under this lock).
      candidateWindow.rows = candidateWindow.rows.filter((row) => groupBShipmentBelongsToPass(mode, row))
      if (candidateWindow.rows.length === 0) return 0
      const candidateShipmentIds = candidateWindow.rows.map((row) => row.id)
      // Row-lock every order this window journals, in id order and BEFORE the cost-layer locks (the order every other
      // writer in this domain uses, so no cycle). A refund stages its unearned reversal, which can sweep the whole
      // remaining deferral, under the same lock; without it the two could each read the other's uncommitted state and
      // both debit Unearned for the same remainder. Everything below (shipments, refunds, reversal rows) is read after
      // the lock, so a refund that committed first is seen and one that comes later waits for this transaction.
      await lockSalesOrders(tx, [...new Set(candidateWindow.rows.map((row) => row.orderId))].sort())
      const lockedCostLayerIds = await lockCostLayersForGroupBWindow(tx, { candidates: candidateWindow.rows })

      const shipmentRows = await tx.shipment.findMany({
        where: { ...groupBShipmentWhere(mode), id: { in: candidateShipmentIds } },
        select: {
          id: true,
          orderId: true,
          warehouseId: true,
          createdAt: true,
          // ACC-H11: the day the goods left, which dates the journal.
          shippedAt: true,
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
              // ACC-H11: Group B never dates a journal before the payment that created the deferral it draws on.
              paidAt: true,
              totalBase: true,
              unearnedRevenueAmount: true,
              // ACC-H12: an order with no deferral stamp is on the COGS-on-shipment path, and the revenue share
              // its shipments record is sized from the same figure Group A1 will later defer.
              revenueDeferredDate: true,
              fxRateToBase: true,
              subtotalBase: true,
              shippingBase: true,
              discountAmount: true,
              pricesIncludeVat: true,
              taxRatePercent: true,
              shoppingLinks: { select: { connector: true } },
              refunds: { select: { id: true, totalBase: true, totalsBasis: true, refundedAt: true } },
              lines: {
                select: {
                  id: true,
                  productId: true,
                  qty: true,
                  totalBase: true,
                  taxRate: { select: { rate: true } },
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
      })

      // The where-clause already splits the two passes by the order's deferral stamp; this restates it on the rows read,
      // so a pass can never process the other pass's shipment (the stamp is only ever written by Group A1, under this lock).
      const shipments = shipmentRows.filter((shipment) => groupBShipmentBelongsToPass(mode, shipment))

      if (shipments.length === 0) {
        return 0
      }

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
              // ACC-H12: units a direct-to-Inventory shipment costed never drew on an allocation pin (Group A2
              // pins only what is still to ship), so they must not relieve one here.
              cogsRelievedFromInventoryAt: null,
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

      // o3d-c08y r2: the locks were taken above, BEFORE any of this was read. What is asserted here is
      // the closure that makes that sound — everything just loaded stays inside the locked set, so no
      // value below can still be changed by a concurrent revaluation. A miss skips the window with a
      // named error rather than posting from a value that may already be stale.
      assertGroupBSnapshotsWereLocked(lockedCostLayerIds, [
        { what: 'the shipment lines it would post', rows: shipments.flatMap((shipment) => shipment.lines) },
        { what: 'the order allocations it would consume from', rows: orderAllocations },
        { what: 'the already-journaled shipment lines it nets against', rows: priorShipmentLines },
        { what: 'the refund lines it nets against', rows: priorRefundLines },
      ])
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
      // o3d-3la07 (M5, D3: REPORT-ONLY). The netting below still sums exactly the PENDING / PROCESSING /
      // SYNCED rows it always did (`countedUnearnedReversalRows`); the read is widened by the CANCELLED
      // rows that may have reached the ledger so the per-order warning can name them. No arithmetic moves.
      const reversalSyncs = await tx.accountingSyncLog.findMany({
        where: {
          AND: [
            { connector: 'xero', type: 'UNEARNED_REV_REVERSAL' },
            UNEARNED_REVERSAL_NETTING_WHERE,
            {
              OR: [
                { referenceType: 'SalesOrder', referenceId: { in: orderIds } },
                { referenceType: 'SalesOrderRefund', referenceId: { in: refunds.map((refund) => refund.id) } },
              ],
            },
          ],
        },
        select: { id: true, referenceType: true, referenceId: true, payload: true, payloadAccountNets: true, ...LEDGER_STANDING_SELECT },
      })
      const reversalSyncsByOrder = new Map<string, Array<{ payload: unknown; payloadAccountNets?: unknown }>>()
      const reversalStandingRowsByOrder = new Map<string, UnearnedReversalSyncRow[]>()
      for (const sync of reversalSyncs) {
        const targetOrderId = sync.referenceType === 'SalesOrder'
          ? sync.referenceId
          : refundIdToOrderId.get(sync.referenceId)
        if (!targetOrderId) continue
        const allRows = reversalStandingRowsByOrder.get(targetOrderId) ?? []
        allRows.push(sync)
        reversalStandingRowsByOrder.set(targetOrderId, allRows)
      }
      for (const [targetOrderId, allRows] of reversalStandingRowsByOrder) {
        reversalSyncsByOrder.set(
          targetOrderId,
          countedUnearnedReversalRows(allRows).map((sync) => ({ payload: sync.payload, payloadAccountNets: sync.payloadAccountNets })),
        )
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
        const negativeBasisOrder = {
          orderId,
          orderRef: firstShipment.order.orderNumber ?? firstShipment.order.externalOrderNumber ?? orderId.slice(0, 8),
        }
        // ACC-H12: an order Group A1 has not deferred yet is costed on shipment (DR COGS / CR Inventory). Its
        // shipments still record their revenue share, sized from the figure A1 will store as the deferral, but
        // post no revenue leg: the invoice already put the revenue in Sales.
        const costedOnShipment = firstShipment.order.revenueDeferredDate === null
        const deferredBase = costedOnShipment
          ? revenueDeferralAmount({ id: orderId, ...firstShipment.order })
          : Number(firstShipment.order.unearnedRevenueAmount ?? firstShipment.order.totalBase)
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
        // o3d-oyur (Codex r2 HIGH): a counted reversal with no readable lines and no compaction summary moved an UNKNOWN amount.
        // The true-up (which recognises the whole remaining deferral) is withheld rather than risk debiting it twice.
        const unreadableUnearnedReversals = unreadableUnearnedReversalRows(reversalSyncsByOrder.get(orderId) ?? [])
        if (unreadableUnearnedReversals.length > 0) {
          await logActivity({
            entityType: 'SALES_ORDER',
            entityId: orderId,
            action: 'daily_batch_trueup_withheld_unreadable_unearned_reversal',
            tag: 'sync',
            level: 'WARNING',
            description: `Order ${firstShipment.order.orderNumber ?? firstShipment.order.externalOrderNumber ?? orderId.slice(0, 8)}: ${unreadableUnearnedReversals.length} UNEARNED_REV_REVERSAL row(s) have no readable lines and no preserved account summary, so how much unearned revenue a refund already reversed cannot be established. Its shipments were NOT journaled this run (no revenue, no COGS, no stamp) and will be retried once the reversal is readable; check the unearned revenue account.`,
            metadata: { orderId, unreadableCount: unreadableUnearnedReversals.length },
            resolveUser: false,
          }).catch(() => { /* a report that cannot be written must not change what the batch posts */ })
        }
        // o3d-3la07 (M5, D3): say which rows the netting rests on that are not ledger facts.
        const unearnedStanding = unearnedReversalStandingReport(reversalStandingRowsByOrder.get(orderId) ?? [])
        const unearnedReport = describeUnearnedReversalReport(
          firstShipment.order.orderNumber ?? firstShipment.order.externalOrderNumber ?? orderId.slice(0, 8),
          unearnedStanding,
        )
        if (unearnedReport) {
          await logActivity({
            entityType: 'SALES_ORDER',
            entityId: orderId,
            action: 'daily_batch_unearned_reversal_netting_unproven',
            tag: 'sync',
            level: 'WARNING',
            description: unearnedReport,
            metadata: { orderId, ...unearnedStanding },
            resolveUser: false,
          }).catch(() => { /* a report that cannot be written must not change what the batch posts */ })
        }
        // o3d-oyur (Codex r3): an unreadable counted reversal means the figure is unknown, so this order's shipments are NOT processed at
        // all this run: no revenue, no COGS, no stamp. Nothing is published for them (results, snapshots and layer decrements are only
        // recorded further down), so shipmentJournalDate stays null and a later run picks them up once the reversal is readable, exactly
        // once. Recognising 0 and stamping the shipment journaled would strand the deferral for good.
        if (unreadableUnearnedReversals.length > 0) continue
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
          // o3d-sidy: before anything is accumulated, so a refusal leaves nothing behind.
          if (hasPrecomputedSnapshots) refuseNegativeBasisShipmentCogs(negativeBasisOrder, shipment.id, shipmentSnapshotsForLines.flat())
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

            // o3d-sidy: the allocation snapshots are rewritten in place by the same revaluation.
            refuseNegativeBasisShipmentCogs(negativeBasisOrder, shipment.id, shipmentCostSnapshot)

            for (const entry of shipmentCostSnapshot) {
              orderLayerDecrements.set(
                entry.costLayerId,
                (orderLayerDecrements.get(entry.costLayerId) ?? 0) + toDecimal(entry.qty).toNumber(),
              )
            }

            const legacyCogs = roundQuantity(sumCostLayerSnapshot(shipmentCostSnapshot), 2)
            const legacyCogsNumber = legacyCogs.toNumber()
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
          // o3d-sidy: a negative-basis refusal is reported with the others at the end of the run —
          // first in the errors and as an ERROR activity entry. See NegativeCostBasisRefusal.
          if (orderError instanceof NegativeCostBasisRefusal) negativeBasisRefusals.push(orderError)
          else result.errors.push(`Group B order ${orderRef}: ${String(orderError)}`)
          // Remove any partially-accumulated results for this order's shipments
          for (const s of orderShipments) {
            const sr = shipmentResults.get(s.id)
            if (sr) {
              shipmentResults.delete(s.id)
            }
            for (const sl of s.lines) shipmentSnapshots.delete(sl.id)
          }
        }
      }

      const processedShipmentCount = shipmentResults.size

      // ACC-H11: ONE JOURNAL PER EVENT DATE. A shipment is dated the later of the day it shipped and the
      // day its order was paid (Group B waits for the deferral, and cannot recognise revenue before the
      // payment that created the Unearned Revenue it draws on). Revenue and COGS of one shipment share
      // that date. Each date is its own journal with its own reference, the identity the stamps carry.
      const processedShipments = shipments.filter((shipment) => shipmentResults.has(shipment.id))
      const groupBDay = (shipment: (typeof shipments)[number]): string | null => laterDay(
        businessDay(shipment.shippedAt ?? shipment.createdAt),
        businessDay(shipment.order.paidAt),
      )
      // ACC-H12: a shipment of an order that is not deferred yet is costed on its own journal, dated the day the
      // goods left (there is no payment to wait for), so its group never mixes with the ordinary ones.
      const isCostedOnShipment = (shipment: (typeof shipments)[number]): boolean => shipment.order.revenueDeferredDate === null
      const bDated = groupByPostingDate(processedShipments.filter((shipment) => !isCostedOnShipment(shipment)), groupBDay, dateContext)
      const bDatedDirect = groupByPostingDate(
        processedShipments.filter(isCostedOnShipment),
        (shipment) => businessDay(shipment.shippedAt ?? shipment.createdAt),
        dateContext,
      )
      if (bDated.deferred.length > 0 || bDatedDirect.deferred.length > 0) throw new Error('Group B: a shipment has no open posting day although the lock-blocks-run check passed')
      const bGroups = [
        ...bDated.groups.map((group) => ({ ...group, costedOnShipment: false })),
        ...bDatedDirect.groups.map((group) => ({ ...group, costedOnShipment: true })),
      ]
      // o3d-hqvrp.32: stock that came back from these shipments before they were journaled has no COGS
      // reversal of its own (refund staging only reads journaled shipments), so it is booked here, in the
      // same journal: DR Inventory / CR COGS. Booked per source shipment, capped by that shipment's COGS.
      const batchShipmentCogs: Array<{ shipmentId: string; orderId: string; cogs: number }> = []
      for (const shipment of shipments) {
        const shipmentResult = shipmentResults.get(shipment.id)
        if (shipmentResult) batchShipmentCogs.push({ shipmentId: shipment.id, orderId: shipment.orderId, cogs: shipmentResult.cogs })
      }
      const unjournaledReturnCredits = await loadUnjournaledReturnCredits(tx, batchShipmentCogs)

      const returnCreditsToRecord: Array<{ credit: (typeof unjournaledReturnCredits)[number]; date: string }> = []
      const bJournalByShipmentId = new Map<string, { referenceId: string; syncLogId: string | null; date: string; costedOnShipment: boolean }>()
      for (const group of bGroups) {
        let groupRevenueRaw = 0
        let groupCogs = toDecimal(0)
        for (const shipment of group.rows) {
          const shipmentResult = shipmentResults.get(shipment.id)!
          groupRevenueRaw += shipmentResult.revenue
          groupCogs = addMoney(groupCogs, shipmentResult.cogs)
        }
        const groupRevenue = round2(groupRevenueRaw)
        const groupCogsNumber = round2Decimal(groupCogs)
        const groupCount = group.rows.length
        const journalLines: JournalLinePayload[] = []

        // Revenue: the ordinary group moves it from Unearned to Sales. A costed-on-shipment group posts none (the
        // invoice already booked it to Sales); the share is still recorded on each shipment below.
        if (groupRevenue > 0 && !group.costedOnShipment) {
          journalLines.push(
            { accountCode: settings.xero_unearned_revenue_account, description: `Revenue recognition — ${groupCount} shipment(s)`, debit: groupRevenue },
            { accountCode: settings.xero_sales_account, description: `Revenue recognition — ${groupCount} shipment(s)`, credit: groupRevenue },
          )
        }

        if (groupCogsNumber > 0) {
          journalLines.push(
            { accountCode: settings.xero_cogs_account, description: `COGS — ${groupCount} shipment(s)`, debit: groupCogsNumber },
            // ACC-H12: units shipped before payment were never reclassified into Allocated Inventory, so there is
            // no allocated debit to relieve: the cost leaves Inventory directly.
            {
              accountCode: group.costedOnShipment ? settings.xero_inventory_account : settings.xero_allocated_inventory_account,
              description: `COGS — ${groupCount} shipment(s)`,
              credit: groupCogsNumber,
            },
          )
          // o3d-hqvrp.32: stock returned before these shipments were journaled is credited in the journal of the
          // date its source shipment is journaled on, capped by that shipment's COGS (see unjournaled-return-cogs.ts).
          const groupShipmentIds = new Set(group.rows.map((shipment) => shipment.id))
          const groupReturnCredits = unjournaledReturnCredits.filter((credit) => groupShipmentIds.has(credit.shipmentId))
          const groupReturnTotal = round2Decimal(groupReturnCredits.reduce((sum, credit) => addMoney(sum, credit.amount), toDecimal(0)))
          if (groupReturnTotal > 0) {
            journalLines.push(
              { accountCode: settings.xero_inventory_account, description: `Returned before journaled — ${groupCount} shipment(s)`, debit: groupReturnTotal },
              { accountCode: settings.xero_cogs_account, description: `Returned before journaled — ${groupCount} shipment(s)`, credit: groupReturnTotal },
            )
            for (const credit of groupReturnCredits) returnCreditsToRecord.push({ credit, date: group.date })
          }
        }

        // o3d-0qoo: identity over the shipments that actually made it into this batch —
        // shipmentResults has already had failed orders' shipments removed, and the stamping
        // loop below skips exactly the same ones, so the digest input and the stamped set are
        // the same set by construction. Persisted per shipment rather than re-derived from
        // shipmentJournalDate, which is written later and can land on the next UTC day.
        const referenceId = buildDailyBatchReferenceId('B', group.date, group.rows.map((shipment) => shipment.id))

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
              date: group.date,
              reference: `Shipment COGS ${group.date} ${referenceId.slice(-8)}`,
              narration: group.costedOnShipment
                ? `Daily shipment batch, shipped before payment: ${groupCount} shipment(s), COGS £${groupCogsNumber.toFixed(2)} relieved from Inventory (revenue already booked by the invoice)${lockedPeriodNarration(group.movedFromLockedDays, lockDate)}`
                : `Daily shipment batch: ${groupCount} shipment(s), revenue £${groupRevenue.toFixed(2)}, COGS £${groupCogsNumber.toFixed(2)}${lockedPeriodNarration(group.movedFromLockedDays, lockDate)}`,
              lines: journalLines,
              batchReferenceId: referenceId,
              batchDate: group.date,
              batchGroup: 'B',
              batchEntityCount: groupCount,
              splitBatch: result.hasMore.groupB,
              _postingMode: 'submitted',
            },
          })
          if (groupCogsNumber > 0) groupBSyncLogId = createdLogId
        }
        for (const shipment of group.rows) {
          bJournalByShipmentId.set(shipment.id, { referenceId, syncLogId: groupBSyncLogId, date: group.date, costedOnShipment: group.costedOnShipment })
        }
        bPostedGroups.push({ date: group.date, movedFromLockedDays: group.movedFromLockedDays })
      }

      // Only mark shipments that were successfully processed. Failed
      // orders had their results removed from shipmentResults by the
      // per-order catch block — those shipments must remain untouched
      // (shipmentJournalDate stays null) so the next batch run retries.
      for (const shipment of shipments) {
        const resultForShipment = shipmentResults.get(shipment.id)
        if (!resultForShipment) continue // failed order — skip, leave retryable
        const journalForShipment = bJournalByShipmentId.get(shipment.id)!
        const referenceId = journalForShipment.referenceId
        const groupBSyncLogId = journalForShipment.syncLogId
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
        const shipmentCostedOnShipment = journalForShipment.costedOnShipment
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
            //
            // ACC-H12: a shipment costed straight out of Inventory raised NO relief of the Allocated Inventory
            // contra (A2 never debited it for these units), so it records £0 and names no journal. The refund
            // service reads a recorded zero as "relieved nothing", which is exactly right.
            allocatedReliefAmount: shipmentCostedOnShipment ? 0 : resultForShipment.cogs,
            // o3d-o97 r4: and WHICH journal raised it, on WHICH ledger, against WHICH account —
            // all null when no CR Allocated Inventory line was raised at all. The refund resolves
            // the id back to the row to read its STATUS, so a Group B journal still queued, or one
            // that ended CANCELLED, is never counted as relief the contra has already received.
            allocatedReliefSyncLogId: shipmentCostedOnShipment ? null : groupBSyncLogId,
            allocatedReliefConnector: !shipmentCostedOnShipment && groupBSyncLogId ? XERO_CONNECTOR : null,
            allocatedReliefAccountCode: !shipmentCostedOnShipment && groupBSyncLogId ? settings.xero_allocated_inventory_account : null,
            // ACC-H12: THE DURABLE MARKER, in the same statement as `shipmentJournalDate`. Group A2, Group B and the
            // refund service read it to tell these units from the ones that went through Allocated Inventory.
            ...(shipmentCostedOnShipment ? {
              cogsRelievedFromInventoryAt: shipmentJournalDate,
              cogsRelievedFromInventoryAmount: resultForShipment.cogs,
              cogsRelievedFromInventorySyncLogId: groupBSyncLogId,
            } : {}),
          },
        })
        // khdw: record this shipment's dispatch COGS in the COGS subledger ledger as
        // an immutable, correctly-dated row. The reconciliation reads the ledger (not
        // the live, revaluation-mutated cogsBatchAmount), so a same-window dispatch +
        // revaluation can't double-count. Idempotent per shipment.
        //
        // Dated on the JOURNAL's date (ACC-H11: the event day; before that, the run's date) — NOT on
        // shipmentJournalDate (o3d-0qoo r1, found by Codex). The GL journal above is posted under that
        // date, while the stamp is written with a later new Date(); on a midnight-crossing run the two
        // differ, and the subledger row would land a day after the journal whose value it records.
        // Reconciliation windows on journalDate, so that gap reads as a real one — and because this
        // upsert is first-write-wins and keyed per shipment, a row written on the wrong day can never be
        // corrected by a later run.
        await recordCogsSubledgerMovement(tx, {
          sourceType: 'DISPATCH',
          sourceRef: shipment.id,
          idempotencyKey: `dispatch:${shipment.id}`,
          baseDelta: resultForShipment.cogs,
          journalDate: journalForShipment.date,
        })
      }

      // The reversal above is in a journal only when that journal's COGS is, and each refund is recorded once,
      // under the same transaction as the journal, dated with it.
      for (const { credit, date } of returnCreditsToRecord) {
        await recordCogsSubledgerMovement(tx, {
          sourceType: 'REFUND_REVERSAL',
          sourceRef: credit.refundId,
          idempotencyKey: unjournaledReturnKey(credit.refundId, credit.shipmentId),
          baseDelta: credit.amount.negated(),
          journalDate: date,
        })
      }

      for (const [layerId, decrement] of layerDecrements) {
        await tx.costLayer.update({
          where: { id: layerId },
          data: { remainingQty: { decrement } },
        })
      }

      return processedShipmentCount
    }, GROUP_B_TX_OPTIONS)
    if (groupBCount > 0) {
      result.groupB += groupBCount
    }
    for (const journal of bPostedGroups) await reportLockedPeriodMoves('B', journal.date, journal.movedFromLockedDays, lockDate)
  } catch (e) {
    result.errors.push(`Group B error: ${String(e)}`)
  }
  }

  await runGroupB('direct')

  // --- Group A1: Revenue Deferral ---
  groupA1Skip: try {
    // o3d-4ajo: Postgres frees a session lock the instant its connection dies,
    // so from that moment another batch — or a refund, which shares this domain
    // — can start while we are still writing. Stop instead.
    batchLock.assertHeld('Group A1 (revenue deferral)')
    if (lockBlocked) {
      await reportLockBlocksRun('A1', lockDate)
      break groupA1Skip
    }
    // DELIBERATELY NOT the shared invoiced-revenue basis (lib/domain/sales/invoiced-revenue-basis.ts).
    // The reports count an order once it carries an invoice, paid or not, and accept a Xeroom-era
    // invoice number. This batch decides what IMS itself must post, so it needs a PAID order whose
    // invoice IMS posted (accountingInvoiceId). The two differ on purpose; do not unify them.
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
        paidAt: true,
        // o3d-hqvrp.35: refunds entered before this first run, netted out of the deferral.
        refunds: { select: { id: true, totalBase: true, totalsBasis: true, refundedAt: true } },
        // ACC-H12: revenue already recorded by shipments whose COGS the batch posted before payment. The invoice
        // put it in Sales and nothing moved it to Unearned Revenue, so the deferral below leaves it out.
        // It also names a shipment that left while the order was unpaid and that the direct pass of Group B has not
        // costed yet (a backlog or a refusal): such an order is not deferred until that shipment is costed.
        shipments: {
          where: { OR: [{ cogsRelievedFromInventoryAt: { not: null } }, { status: 'SHIPPED', shipmentJournalDate: null }] },
          select: { revenueRecognizedAmount: true, cogsRelievedFromInventoryAt: true, shipmentJournalDate: true, shippedAt: true, createdAt: true },
        },
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
    // ACC-H12: an order whose shipment left before it was paid and is still waiting for its direct cost is not
    // deferred yet. Deferring it first would send the ship-date COGS down the ordinary path at the payment date.
    const awaitingDirectCost = (order: (typeof orderWindow.rows)[number]): boolean => (order.shipments ?? []).some((shipment) => (
      !shipment.cogsRelievedFromInventoryAt
      && !shipment.shipmentJournalDate
      && !!order.paidAt
      && shippedBeforePayment({ paidAt: order.paidAt, shippedAt: shipment.shippedAt, createdAt: shipment.createdAt })
    ))
    const orders = orderWindow.rows.filter((order) => !awaitingDirectCost(order))
    result.hasMore.groupA1 = orderWindow.hasMore

    if (orders.length > 0) {
      // o3d-y14: derived through the SAME function the in-transaction fence re-derives with, so a
      // disagreement can only mean the ORDER moved — never that the two sides do different sums.
      // `amount` is the NETTED figure (what the order stores and the fence re-derives); `grossAmount` is what the
      // paid-day journal moves, so a refund entered in a LATER period never changes an earlier period's journal.
      const shippedRevenueOf = (order: (typeof orders)[number]): number => (
        (order.shipments ?? []).filter((shipment) => !!shipment.cogsRelievedFromInventoryAt).reduce((sum, shipment) => sum + Number(shipment.revenueRecognizedAmount ?? 0), 0)
      )
      const orderDeferrals = orders.map((order) => {
        const amount = revenueDeferralAmount(order)
        const shippedRevenue = shippedRevenueOf(order)
        // ACC-H12: refunds of goods that shipped before payment never took value out of the deferral (their revenue is
        // still in Sales and the credit note reverses it), so the order stores the net figure PLUS that part. Group B's
        // true-up and the refund service then see exactly what the ledger holds in Unearned Revenue. The fence still
        // compares `amount`, the net figure.
        const parts = preBatchRefundDeferredParts(order.refunds, revenueDeferralGrossAmount(order), shippedRevenue)
        const undeferredRefunds = parts.reduce((sum, part) => sum + part.amount - part.deferredPart, 0)
        return {
          orderId: order.id,
          amount,
          storedAmount: round2(amount + undeferredRefunds),
          // Only the part not yet shipped moves from Sales to Unearned Revenue.
          grossAmount: Math.max(0, round2(revenueDeferralGrossAmount(order) - shippedRevenue)),
        }
      })
      // ACC-H11: one journal per EVENT date (the day the order was paid), each with its own reference. The
      // fence below still covers EVERY order of the run in one lock, once.
      const orderById = new Map(orders.map((order) => [order.id, order]))
      const a1Dated = groupByPostingDate(
        orderDeferrals,
        (deferral) => businessDay(orderById.get(deferral.orderId)?.paidAt),
        dateContext,
      )
      if (a1Dated.deferred.length > 0) throw new Error('A1: an order has no open posting day although the lock-blocks-run check passed')
      const a1Plans = a1Dated.groups.map((group) => {
        const totalRevenueDeferred = round2(group.rows.reduce((sum, order) => sum + order.grossAmount, 0))
        const invariantTotal = round2(group.rows.reduce((sum, order) => sum + order.grossAmount, 0))
        if (Math.abs(invariantTotal - totalRevenueDeferred) > 0.01) {
          throw new Error(`A1 revenue deferral invariant failed: per-order ${invariantTotal.toFixed(2)} != journal ${totalRevenueDeferred.toFixed(2)}`)
        }
        const journalLines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = []
        if (totalRevenueDeferred > 0) {
          journalLines.push(
            { accountCode: settings.xero_sales_account, description: `Daily revenue deferral — ${group.rows.length} order(s)`, debit: totalRevenueDeferred },
            { accountCode: settings.xero_unearned_revenue_account, description: `Daily revenue deferral — ${group.rows.length} order(s)`, credit: totalRevenueDeferred },
          )
        }
        // o3d-0qoo: computed ONCE, here, and stamped onto every member order inside the same
        // transaction as the stage stamp. It is deliberately NOT re-derived per order from
        // revenueDeferredDate: `today` is captured at run start while the stamps are written
        // with later new Date() calls, so a run crossing UTC midnight makes the two disagree
        // and every consumer that re-derives looks for a batch that does not exist.
        // ACC-H11: the reference carries the JOURNAL's date (the event day), so the persisted reference
        // stays the batch's identity and its date for every consumer.
        const referenceId = buildDailyBatchReferenceId('A1', group.date, group.rows.map((row) => row.orderId))
        return { group, totalRevenueDeferred, journalLines, referenceId }
      })

      // ACC-H13 + ACC-H11: each refund entered before this first run is a SEPARATE adjustment (DR Unearned
      // Revenue / CR Sales, the same direction the refund service uses after a deferral), dated the day of the
      // refund (never before the deferral it adjusts) and subject to the same lock rule. One journal per date.
      type RefundAdjustmentRow = { orderId: string; refundId: string | null; amount: number; day: string | null }
      const adjustmentRows: RefundAdjustmentRow[] = []
      for (const order of orders) {
        const paidDay = businessDay(order.paidAt)
        for (const adjustment of preBatchRefundDeferredParts(order.refunds, revenueDeferralGrossAmount(order), shippedRevenueOf(order))) {
          // ACC-H12: only the part of a refund that came out of deferred revenue is adjusted against Unearned.
          if (!(adjustment.deferredPart > 0)) continue
          adjustmentRows.push({
            orderId: order.id,
            refundId: adjustment.refundId,
            amount: adjustment.deferredPart,
            day: laterDay(businessDay(adjustment.refundedAt), paidDay),
          })
        }
      }
      const adjustmentDated = groupByPostingDate(adjustmentRows, (row) => row.day, dateContext)
      if (adjustmentDated.deferred.length > 0) throw new Error('A1: a refund adjustment has no open posting day although the lock-blocks-run check passed')
      const adjustmentPlans = adjustmentDated.groups.map((group) => {
        const total = round2(group.rows.reduce((sum, row) => sum + row.amount, 0))
        // The identity digest is over a distinct namespace so it can never collide with the paid-day journal of the same date.
        const referenceId = buildDailyBatchReferenceId('A1', group.date, group.rows.map((row) => `refund-adjustment:${row.refundId ?? row.orderId}`))
        return { group, total, referenceId }
      })

      await db.$transaction(async (tx) => {
        // o3d-y14: every figure below — the payload, the journal total and the per-order stamp —
        // was derived from a read taken OUTSIDE this transaction and without a lock. Re-derive it
        // now that the member rows are locked, and refuse the whole group rather than persist a
        // deferral the order itself contradicts. See daily-batch-discount-fence.ts.
        await assertRevenueDeferralsUnchanged(tx, orderDeferrals)

        for (const plan of adjustmentPlans) {
          if (plan.total <= 0) continue
          await createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_REVENUE_DEFERRAL',
            referenceId: plan.referenceId,
            currency: baseCurrency,
            payload: {
              date: plan.group.date,
              reference: `Revenue Deferral refund adjustment ${plan.group.date} ${plan.referenceId.slice(-8)}`,
              narration: `Revenue deferral adjustment for refund(s) entered before the first batch run: ${plan.group.rows.length} refund(s), £${plan.total.toFixed(2)}${lockedPeriodNarration(plan.group.movedFromLockedDays, lockDate)}`,
              lines: [
                { accountCode: settings.xero_unearned_revenue_account, description: `Pre-batch refund adjustment — ${plan.group.rows.length} refund(s)`, debit: plan.total },
                { accountCode: settings.xero_sales_account, description: `Pre-batch refund adjustment — ${plan.group.rows.length} refund(s)`, credit: plan.total },
              ],
              refundAdjustments: plan.group.rows,
              batchReferenceId: plan.referenceId,
              batchDate: plan.group.date,
              batchGroup: 'A1',
              batchEntityCount: plan.group.rows.length,
              splitBatch: result.hasMore.groupA1,
              _postingMode: 'submitted',
            },
          })
          // The durable witness: each refund carries the adjustment journal that netted it, in the same
          // transaction as the journal, so a lost log can be rebuilt (and rebuilt once) and the rebuilt paid-day
          // journal knows which refunds to add back.
          const stampedRefundIds = plan.group.rows.map((row) => row.refundId).filter((id): id is string => !!id)
          if (stampedRefundIds.length > 0) {
            await tx.salesOrderRefund.updateMany({ where: { id: { in: stampedRefundIds } }, data: { deferralAdjustmentRef: plan.referenceId } })
          }
        }

        for (const plan of a1Plans) {
          const { group, totalRevenueDeferred, journalLines, referenceId } = plan
          if (journalLines.length > 0) {
            await createPendingSyncLog(tx, {
              type: 'DAILY_BATCH_REVENUE_DEFERRAL',
              referenceId,
              currency: baseCurrency,
              payload: {
                date: group.date,
                reference: `Revenue Deferral ${group.date} ${referenceId.slice(-8)}`,
                narration: `Daily revenue deferral: ${group.rows.length} order(s), £${totalRevenueDeferred.toFixed(2)}${lockedPeriodNarration(group.movedFromLockedDays, lockDate)}`,
                lines: journalLines,
                orderDeferrals: group.rows,
                batchReferenceId: referenceId,
                batchDate: group.date,
                batchGroup: 'A1',
                batchEntityCount: group.rows.length,
                splitBatch: result.hasMore.groupA1,
                _postingMode: 'submitted',
              },
            })
          }

          const deferralByOrderId = new Map(group.rows.map((order) => [order.orderId, order.storedAmount]))
          for (const deferral of group.rows) {
            await tx.salesOrder.update({
              where: { id: deferral.orderId },
              data: {
                revenueDeferredDate: new Date(),
                revenueDeferredBatchRef: referenceId,
                unearnedRevenueAmount: deferralByOrderId.get(deferral.orderId) ?? 0,
              },
            })
          }
        }
      })
      for (const plan of a1Plans) await reportLockedPeriodMoves('A1', plan.group.date, plan.group.movedFromLockedDays, lockDate)
      for (const plan of adjustmentPlans) await reportLockedPeriodMoves('A1', plan.group.date, plan.group.movedFromLockedDays, lockDate)

      result.groupA1 = orders.length
    }
  } catch (e) {
    // o3d-y14: the fence aborts the transaction, so nothing recorded the refusal. Log it here,
    // OUTSIDE the rolled-back transaction, before it becomes one more line in result.errors.
    if (e instanceof StaleDailyBatchDeferralError) await logStaleDailyBatchDeferral(XERO_CONNECTOR, e)
    result.errors.push(`Group A1 error: ${String(e)}`)
  }

  // --- Group A2: Inventory Reclassification ---
  groupA2Skip: try {
    // o3d-4ajo: Postgres frees a session lock the instant its connection dies,
    // so from that moment another batch — or a refund, which shares this domain
    // — can start while we are still writing. Stop instead.
    batchLock.assertHeld('Group A2 (inventory reclassification)')
    if (lockBlocked) {
      await reportLockBlocksRun('A2', lockDate)
      break groupA2Skip
    }
    // o3d-0i5y r9 — THE PLAN AND THE STAMP NOW DESCRIBE THE SAME STATE OF THE ORDER.
    //
    // This selection used to run on `db`, OUTSIDE the transaction below and under no row lock. Every
    // input A2 decides on — the allocation rows, their records, the dispatched lines — was therefore
    // a snapshot of a moment that had already passed by the time the transaction opened, while the
    // writes at the end of it (the row records, the stamp, the batch ref, the amount) landed
    // unconditionally on the rows as they stood THEN. Between the two, the very paths that share
    // this domain move exactly these rows: `allocateSalesOrder` rewrites the allocation set and
    // carries the records between scopes, a refund un-stages and reverses, a dispatch writes
    // shipment snapshots. The batch's session lock does not close this — it excludes another BATCH,
    // not an operator re-allocating an order from the UI.
    //
    // Three concrete losses, all of them money:
    //
    //   * a re-allocation that lands in the gap has its NEW record overwritten by `next`, which was
    //     computed from the OLD one — so units the rewrite carried to another warehouse are
    //     re-presented as unaccounted and posted a second time, or a record is erased outright.
    //   * an allocation row deleted in the gap makes the per-row `update` throw, aborting a
    //     transaction that has already valued every other order in the window.
    //   * quantity ADDED in the gap is stamped as accounted without ever being valued: the stamp is
    //     order-level, so A2 never looks at the order again, and Group B still credits Allocated
    //     Inventory for it when it ships.
    //
    // So the read moves inside the transaction that writes, and the orders are ROW-LOCKED before
    // anything is read off them — the shape `e2mz`, `small2` and `settle` all closed tonight, and
    // the shape `buildLayerSnapshot` just below already uses for cost layers: select the candidates,
    // lock them, then re-read under the lock and re-apply the eligibility test, so an order that
    // stopped qualifying while we waited for the lock is dropped rather than posted.
    // o3d-sidy r2 (review MEDIUM) — REFUSED ORDERS MUST NOT STARVE THE WINDOW.
    //
    // A refused order keeps its place at the front of the window (it stays eligible, and the window
    // is `revenueDeferredDate asc`), so a window filled with refused orders would reclassify nothing
    // every night while healthy orders queued behind it. So a pass that refused anything and left
    // candidates behind is followed by another pass that EXCLUDES every order refused so far, given
    // only the slots this run has not yet spent on ACCEPTED orders — the run still reclassifies at
    // most `batchLimit` orders. It terminates: every further pass either accepts nothing new and
    // refuses nothing (stop), or refuses at least one more order, which the next pass excludes, so
    // the candidate set shrinks strictly. Each pass is its own transaction and its own journal, the
    // same shape a batch already takes when it is split across runs.
    //
    // o3d-sidy r2 (review LOW 2): a pass's refusals are PUBLISHED only once its transaction has
    // committed. A pass that later aborts (a "Missing FIFO snapshot" on another order, say) rolls back
    // as a whole and is reported as the group error it is; its refusals are not reported as if the
    // rest of that pass had gone through.
    const refusedA2OrderIds = new Set<string>()
    let a2Accepted = 0
    let a2HasMore = false
    for (;;) {
      const passLimit = batchLimit - a2Accepted
      if (passLimit <= 0) break
      const passRefusals: NegativeCostBasisRefusal[] = []
      const groupA2 = await db.$transaction(async (tx) => {
        const candidateWindow = takeDailyBatchWindow(await tx.salesOrder.findMany({
          where: refusedA2OrderIds.size > 0
            ? { ...A2_ELIGIBLE_ORDER, id: { notIn: [...refusedA2OrderIds] } }
            : A2_ELIGIBLE_ORDER,
          orderBy: A2_ORDER_SELECTION_ORDER,
          select: { id: true },
          take: passLimit + 1,
        }), passLimit)
        const candidateIds = candidateWindow.rows.map((row) => row.id)
        if (candidateIds.length === 0) return { count: 0, hasMore: candidateWindow.hasMore, journals: [] as Array<{ date: string; movedFromLockedDays: string[] }> }
        await lockSalesOrders(tx, candidateIds)

        // Re-read UNDER THE LOCK, and re-apply the eligibility test as a WHERE rather than trusting
        // the candidate list: the permission to post this order is evaluated in exactly one place,
        // immediately before the act it authorises. An order that was stamped, fully refunded or
        // cancelled while we blocked on its lock simply is not in this result.
        const orders = await tx.salesOrder.findMany({
          where: { id: { in: candidateIds }, ...A2_ELIGIBLE_ORDER },
          orderBy: A2_ORDER_SELECTION_ORDER,
          select: {
            id: true,
            orderNumber: true,
            externalOrderNumber: true,
            status: true,
            // ACC-H11: the journal is dated by the event - paid, and stock allocated.
            paidAt: true,
            // o3d-0i5y r5 (rebase onto o3d-o97): what EARLIER A2 passes already recorded posting for
            // this order. Since the residual rebuild hands a stamped order back for the INCREMENT,
            // this pass is no longer necessarily the first, and the order-level record has to be the
            // running total rather than the latest instalment. Read under the same lock as everything
            // else A2 plans from.
            allocationBatchAmount: true,
            // o3d-i0o6 r3: and the pass history that figure is the sum of, read in the same statement
            // so this pass appends to what it actually planned from.
            allocationBatchPasses: true,
            allocations: {
              select: {
                id: true,
                lineId: true,
                productId: true,
                warehouseId: true,
                qty: true,
                createdAt: true,
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
                // ACC-H12: shipments already costed straight out of Inventory are not A2's to value or record.
                cogsRelievedFromInventoryAt: true,
                // o3d-0i5y r7: the journal date is deliberately NOT read. What a pass owes is decided by
                // the allocation row's own entries against the dispatched quantity — see
                // `planA2Reclassification`. Selecting a shipment's journal date here only ever supported
                // the whole-shipment valuation that re-posted the pinned part of a mixed shipment.
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
        })
        if (orders.length === 0) return { count: 0, hasMore: candidateWindow.hasMore, journals: [] as Array<{ date: string; movedFromLockedDays: string[] }> }

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
        /**
         * o3d-0i5y r10: the entries THIS pass adds to a row, kept apart from the ones it merely read.
         *
         * A2 appends; it never authors what is already on the row. Holding the two halves separately
         * is what lets the write rebase its append onto the record AS LOCKED instead of replaying the
         * base it planned from — see `lockAllocationRecords`.
         */
        const allocationAppends = new Map<string, CostLayerSnapshotEntry[]>()
        /** The quantity the planned-from base recorded, so a base that MOVED can be told from one that was revalued. */
        const allocationBaseQty = new Map<string, Decimal>()

        // o3d-sidy (review H1): orders refused for a negative basis. Everything this pass computed for
        // them is withdrawn before any journal, stamp or record is written, so they are exactly as if
        // this batch had never seen them — see the refusal below the allocation loop.
        const refusedOrderIds = new Set<string>()

        for (const order of orders) {
          const plan = plans.get(order.id)!
          // o3d-sidy: what this order took from the shared in-memory layer snapshot, so a refusal can
          // hand it back and the orders after it value exactly as they would without this one.
          const orderConsumption: Array<{ productId: string; warehouseId: string; consumed: CostLayerSnapshotEntry[] }> = []
          const orderAppended: CostLayerSnapshotEntry[] = []
          // o3d-0i5y r7: value is accumulated ROW BY ROW, from the entries this pass actually writes.
          // r6 valued the whole unjournaled shipment here instead, which posts the WHOLE of a MIXED
          // shipment — part of it already pinned and posted by an earlier pass. See the shipment-
          // sourced term below.
          let orderCostValue = toDecimal(0)

          // Rows that have never been reclassified at all, owe nothing and have nothing to record are
          // still STAMPED with an empty snapshot, exactly as before.
          for (const allocationId of plan.stampEmptyAllocationIds) {
            allocationSnapshots.set(allocationId, [])
            allocationAppends.set(allocationId, [])
            allocationBaseQty.set(allocationId, toDecimal(0))
          }

          for (const alloc of order.allocations) {
            const outstanding = plan.outstandingByAllocation.get(alloc.id)
            const shipmentAccounted = plan.shipmentAccountedByAllocation.get(alloc.id)
            if (!outstanding && !shipmentAccounted) continue
            // o3d-0i5y r8: the row's RECORD — what earlier passes already accounted and posted. It
            // is both the base the new entries are appended to and the pool the shipment take is
            // netted by, so a dispatched entry this row has already valued can never be valued again.
            const alreadyRecorded = parseCostLayerSnapshot(alloc.costLayerSnapshot)
            // o3d-0i5y r6: units this pass is accounting from the SHIPMENT snapshots, written onto the
            // row so a later pass reads them as evidence instead of inferring them from an overlap.
            // They add NO value here — the shipment value is posted once, above, and only while the
            // shipment is unjournaled — this is a record of quantity already in the ledger.
            const recorded = shipmentAccounted
              ? takeShipmentAccountedEntries(
                  alreadyRecorded,
                  order.shipments
                    .filter((shipment) => shipment.warehouseId === alloc.warehouseId && !shipment.cogsRelievedFromInventoryAt)
                    .flatMap((shipment) => shipment.lines.filter((line) => (
                      line.lineId === alloc.lineId && line.productId === alloc.productId
                    ))),
                  shipmentAccounted,
                  alloc.id,
                )
              : []
            // o3d-0i5y r7: THE RECORD IS ALSO THE VALUATION, and it must be, because the row is the
            // only place that says which dispatched units A2 has already posted. `shipmentAccounted`
            // is dispatched quantity NO entry on the row accounts for, so these entries are exactly
            // the units whose cost has never reached Allocated Inventory — never the pinned part of
            // the same shipment, which is what r6's whole-shipment sum re-posted every pass.
            //
            // A short take can only mean a dispatched line carries no snapshot to record. r6 let that
            // stand as a silent under-account; it is now as loud as r5's whole-shipment guard was,
            // and names the row and the quantity rather than the batch.
            if (shipmentAccounted) {
              const recordedQty = sumCostLayerSnapshotQty(recorded)
              if (recordedQty.lt(shipmentAccounted)) {
                throw new Error(
                  `Missing FIFO snapshot on shipped line(s) for allocation ${alloc.id} on order ${order.id}: `
                  + `${shipmentAccounted.toString()} dispatched unit(s) to account for, only ${recordedQty.toString()} recoverable`,
                )
              }
            }
            const consumed = outstanding
              ? consumeSnapshotLayers(
                  snapshot,
                  alloc.productId,
                  alloc.warehouseId,
                  outstanding.toNumber(),
                )
              : []
            orderConsumption.push({ productId: alloc.productId, warehouseId: alloc.warehouseId, consumed })
            orderAppended.push(...recorded, ...consumed)
            // APPENDED, not replaced, so `snapshotQty` keeps naming everything ever posted against
            // this row — which is what makes the next pass's outstanding calculation right. The
            // shipped record goes BEFORE the fresh pin, so the qty-based contra relief that Group B
            // and the refund reversal run for each shipment line consumes exactly those units and
            // leaves the unshipped pin standing.
            //
            // o3d-0i5y r9: the entries THIS pass values are stamped with WHAT IT VALUED THEM AT, in
            // this same statement — and the journal for that amount is raised in this same
            // transaction, a few lines below. `alreadyRecorded` is left exactly as it is: an earlier
            // pass stamped it with the amount IT posted, and re-stamping at today's cost would turn
            // a record of a historical posting into a revaluation of it. That is the whole point of
            // the field — a landed-cost correction rewrites `unitCostBase` on these very rows
            // without touching Allocated Inventory, so the pin stops being able to say what was
            // debited the moment it is revalued.
            //
            // o3d-0i5y r10: the append is kept SEPARATE from `alreadyRecorded`, because the write is
            // no longer allowed to replay the base it planned from — see `lockAllocationRecords` and
            // the write loop below.
            const appended = [
              ...recorded.map(withPostedUnitCost),
              ...consumed.map(withPostedUnitCost),
            ]
            allocationAppends.set(alloc.id, appended)
            allocationBaseQty.set(alloc.id, sumCostLayerSnapshotQty(alreadyRecorded))
            allocationSnapshots.set(alloc.id, [...alreadyRecorded, ...appended])
            orderCostValue = addMoney(
              orderCostValue,
              addMoney(sumCostLayerSnapshot(recorded), sumCostLayerSnapshot(consumed)),
            )
          }
          orderCostValue = roundQuantity(orderCostValue, 2)

          // o3d-sidy (review H1) — A2 REFUSES A NEGATIVE BASIS PER ORDER, BEFORE ANYTHING IS WRITTEN.
          //
          // Both halves of what this pass values can carry one: `recorded` comes off the shipment
          // snapshots, which a landed-cost revaluation rewrites in place (same-day allocate-and-ship is
          // the ordinary case), and `consumed` off live layers whose unit cost the same revaluation
          // changed. Unrefused, the negative was debited to Allocated Inventory short, stamped onto the
          // order and pinned as `postedUnitCostBase`, and the correction that followed re-valued the
          // layer and left the ledger short for good. PER ORDER, like Group B, rather than failing the
          // whole transaction: A2 is ONE journal for every order in the window, and aborting it would
          // hold back every other order's reclassification — and so every other order's Group B, which
          // waits for this stamp — until one purchase order was corrected.
          //
          // o3d-sidy r2 (review MEDIUM) — WHAT "PER ORDER" MEANS FOR A NEGATIVE LIVE LAYER. The refused
          // order hands its layers back, so the next order's FIFO take starts from the same place and
          // reaches the same negative layer: ONE negative layer refuses EVERY order whose take reaches
          // it (2 units at -6 ahead of 5 at 20, three 1-unit orders: all three refused), not just the
          // negative quantity, until the basis is corrected. That is deliberate — it values each order
          // exactly as if the refused ones were absent — and the window loop above keeps those refused
          // orders from starving the orders behind them.
          const negative = negativeBasisEntries(orderAppended)
          if (negative.length > 0) {
            for (const { productId, warehouseId, consumed } of orderConsumption) {
              returnSnapshotLayers(snapshot, productId, warehouseId, consumed)
            }
            for (const alloc of order.allocations) {
              allocationSnapshots.delete(alloc.id)
              allocationAppends.delete(alloc.id)
              allocationBaseQty.delete(alloc.id)
            }
            refusedOrderIds.add(order.id)
            const orderRef = order.orderNumber ?? order.externalOrderNumber ?? order.id.slice(0, 8)
            passRefusals.push(new NegativeCostBasisRefusal(
              `Group A2 order ${orderRef}: negative cost basis — cost layer(s) ${describeNegativeEntries(negative)}; `
              + `the reclassification would be ${orderCostValue.toFixed(2)}. Not reclassified, so its shipments `
              + `wait too. ${NEGATIVE_BASIS_REMEDY}reclassifies it and posts its COGS (o3d-sidy).`,
              {
                group: 'A2', orderId: order.id, orderRef, shipmentId: null, batchRef: null,
                negativeEntries: negativeEntryDetail(negative), value: orderCostValue.toFixed(2),
              },
            ))
            continue
          }

          orderValues.set(order.id, orderCostValue.toNumber())
        }

        // o3d-sidy: the batch is built from the orders that were NOT refused, and only from them.
        const accepted = orders.filter((order) => !refusedOrderIds.has(order.id))
        if (accepted.length === 0) return { count: 0, hasMore: candidateWindow.hasMore, journals: [] as Array<{ date: string; movedFromLockedDays: string[] }> }
        // ACC-H11: ONE JOURNAL PER EVENT DATE. An order's reclassification is dated the later of the day it
        // was paid and the day its stock was allocated (the rows this pass actually touched), so a backorder
        // allocated weeks after payment lands on the day the stock arrived. Each date is its own journal with
        // its own reference; each order is stamped with the journal that carries ITS pounds.
        const a2OrderDay = (order: (typeof accepted)[number]): string | null => laterDay(
          businessDay(order.paidAt),
          ...order.allocations
            .filter((alloc) => allocationSnapshots.has(alloc.id))
            .map((alloc) => businessDay(alloc.createdAt)),
        )
        const a2Dated = groupByPostingDate(accepted, a2OrderDay, dateContext)
        if (a2Dated.deferred.length > 0) throw new Error('A2: an order has no open posting day although the lock-blocks-run check passed')
        const a2Groups = a2Dated.groups
        const a2JournalByOrderId = new Map<string, { referenceId: string; syncLogId: string | null }>()
        const a2PostedGroups: Array<{ date: string; movedFromLockedDays: string[] }> = []
        for (const group of a2Groups) {
          // o3d-0qoo: batch identity, computed once from this journal's own date and order set, then
          // persisted on every member row alongside its stage stamp. See the A1 note above for why
          // deriving it back from inventoryAllocatedDate is not equivalent.
          // o3d-0i5y r9: derived from the LOCKED set, so the ref names the orders the journal is
          // actually built from rather than the ones a pre-transaction read happened to see.
          // o3d-sidy: and from the ACCEPTED set, so a refused order is not named by a batch it is not in.
          const referenceId = buildDailyBatchReferenceId('A2', group.date, group.rows.map((order) => order.id))
          let groupValue = toDecimal(0)
          for (const order of group.rows) groupValue = addMoney(groupValue, orderValues.get(order.id) ?? 0)
          const groupValueNumber = round2Decimal(groupValue)
          // o3d-o97 r3: null when NO journal was raised. The guard below is on the batch's ROUNDED
          // total, so a window whose only member values at £0.004 stamps that order with an amount
          // and creates no journal at all — which is exactly the inference ("an amount implies a
          // pass that created a journal") the refund reversal used to rest on.
          let groupSyncLogId: string | null = null
          if (groupValueNumber > 0) {
            groupSyncLogId = await createPendingSyncLog(tx, {
              type: 'DAILY_BATCH_INVENTORY_ALLOC',
              referenceId,
              currency: baseCurrency,
              payload: {
                date: group.date,
                reference: `Inventory Allocation ${group.date} ${referenceId.slice(-8)}`,
                narration: `Daily inventory reclassification: ${group.rows.length} order(s), £${groupValueNumber.toFixed(2)}${lockedPeriodNarration(group.movedFromLockedDays, lockDate)}`,
                lines: [
                  { accountCode: settings.xero_allocated_inventory_account, description: `Daily inventory allocation — ${group.rows.length} order(s)`, debit: groupValueNumber },
                  { accountCode: settings.xero_inventory_account, description: `Daily inventory allocation — ${group.rows.length} order(s)`, credit: groupValueNumber },
                ],
                batchReferenceId: referenceId,
                batchDate: group.date,
                batchGroup: 'A2',
                batchEntityCount: group.rows.length,
                splitBatch: result.hasMore.groupA2,
                _postingMode: 'submitted',
              },
            })
          }
          for (const order of group.rows) a2JournalByOrderId.set(order.id, { referenceId, syncLogId: groupSyncLogId })
          a2PostedGroups.push({ date: group.date, movedFromLockedDays: group.movedFromLockedDays })
        }

        // -----------------------------------------------------------------------------------
        // o3d-0i5y r10 (Codex round 10, finding 4) — THE WRITE REBASES ONTO THE ROW AS LOCKED.
        //
        // r9 moved the PLAN inside the transaction and under the orders' row locks, which was the
        // right half of the fix. This is the other half: the write the plan leads to. It rewrites the
        // WHOLE `costLayerSnapshot` array, and the front of that array is `alreadyRecorded` — entries
        // read at the top of this transaction and not touched by A2 since.
        //
        // One writer can change them in that window, and it is not covered by the sales-order lock:
        // `updateSnapshotsForCostLayerChange` rewrites `unitCostBase` in place on `order_allocations`
        // when a landed cost lands late. It takes no order lock (it selects by cost layer, across
        // every table that carries a snapshot), so it commits freely between A2's read and A2's
        // write — and then A2 writes the array it read and the correction is gone.
        //
        //   a layer bought at £4 is corrected to £5 while the batch runs. 10 recorded units on the
        //   row are repriced £40 -> £50 and the revaluation posts that £10 to COGS/Inventory.
        //   A2 then writes back its planned array, at £4. The row says £40 again while the ledger
        //   says £50, and Group B relieves those units at £4 when they ship: £10 of real cost never
        //   reaches COGS, permanently, and the refund reversal reverses the same £10 short.
        //
        // So the base is RE-READ under the row lock at the moment of writing, and this pass's own
        // entries are appended to THAT. A2 appends; it does not author what it merely read. The
        // append is unaffected — `recorded` and `consumed` are this pass's own valuations, stamped
        // with `postedUnitCostBase` — and a correction that lands after the lock waits for it, then
        // patches the array A2 committed.
        //
        // A base whose QUANTITY moved is a different matter and is refused: the revaluation cannot
        // change quantities or entry counts (it maps each entry to itself), so a base that grew or
        // shrank means a writer nothing here can account for, and the plan built on it — `outstanding`
        // above all — is describing a row that no longer exists. It cannot be reached today, because
        // every path that changes WHICH units are recorded takes the order lock this pass holds.
        const lockedRecords = await lockAllocationRecords(
          tx,
          accepted.flatMap((order) => order.allocations
            .filter((alloc) => allocationSnapshots.has(alloc.id))
            .map((alloc) => alloc.id)),
        )

        for (const order of accepted) {
          for (const alloc of order.allocations) {
            const next = allocationSnapshots.get(alloc.id)
            // `undefined` means "this row was already accounted and is not being changed". It is NOT
            // the same as `[]`, which is a deliberate stamp; writing `?? []` here would erase the
            // pinned layers of every row a previous pass posted (o3d-0i5y r5).
            if (!next) continue
            const lockedBase = parseCostLayerSnapshot(lockedRecords.get(alloc.id) ?? null)
            const plannedBaseQty = allocationBaseQty.get(alloc.id) ?? toDecimal(0)
            const lockedBaseQty = sumCostLayerSnapshotQty(lockedBase)
            if (!lockedBaseQty.eq(plannedBaseQty)) {
              throw new Error(
                `Allocation ${alloc.id} on order ${order.id} recorded ${plannedBaseQty.toString()} unit(s) when this `
                + `pass planned from it and ${lockedBaseQty.toString()} unit(s) under the write lock — the record moved `
                + 'under Group A2 and the plan built on it cannot be trusted',
              )
            }
            const written = [...lockedBase, ...(allocationAppends.get(alloc.id) ?? [])]
            await tx.orderAllocation.update({
              where: { id: alloc.id },
              data: {
                costLayerSnapshot: written as never,
                // o3d-o97 r3: the pounds this row contributed to the DR above, pinned beside the
                // layers it was pinned from. Revaluation rewrites those layers' unitCostBase in
                // the snapshot; it never posts to Allocated Inventory, so this figure is what a
                // refund of part of this row has to reverse at.
                //
                // o3d-0i5y r10 (rebase): read off the array actually WRITTEN — the record re-read
                // under the write lock plus this pass's appends — never the array this pass planned
                // from. A landed-cost correction landing mid-batch rewrites the former and not the
                // latter, and writing the planned copy back is how £10 of real cost never reaches
                // COGS. And the figure is the POSTED basis where the entries carry one, so an
                // earlier pass's pounds are the pounds it debited rather than what its layers have
                // been revalued to since; pre-r9 entries carry no posted basis, and for those the pin
                // is the only evidence there is, exactly as before.
                //
                // Where THIS pass raised no journal an EARLIER pass's record is left alone rather
                // than nulled: `undefined` is "do not update", while `null` would erase a debit that
                // is still standing and is the evidence-deletion o3d-o97 r4 refused.
                allocationBatchAmount: a2JournalByOrderId.get(order.id)?.syncLogId
                  ? roundQuantity(recordedPostedBasis(written), 4).toNumber()
                  : lockedBase.length > 0 ? undefined : null,
              },
            })
          }
          await tx.salesOrder.update({
            where: { id: order.id },
            data: {
              inventoryAllocatedDate: new Date(),
              inventoryAllocatedBatchRef: a2JournalByOrderId.get(order.id)?.referenceId,
              // o3d-o97 r3 + o3d-0i5y r5: the pounds A2 has debited to Allocated Inventory for this
              // order — ACCUMULATED, not replaced. o3d-o97 wrote this as one pass's figure because
              // the stamp only ever came off an order A2 was about to re-value in full. It does not
              // any more: `resetAllocationAccountingIfStaged` hands a stamped order back when the
              // declared set leaves NEW quantity, and A2 then posts that increment alone. Replacing
              // the figure would leave the order recording £20 of a £70 debit, and the refund's open
              // balance would strand the other £50 permanently.
              //
              // o3d-i0o6 r3 — AND THE ATTRIBUTION IS ACCUMULATED WITH IT, BY THE SAME CALL. The amount
              // was cumulative while the journal id, connector and account code beside it were
              // REPLACED by this pass, so the row said "£55, carried by the £5 journal" and a proof
              // read the second half as covering the first. `buildAllocationDebitOrderUpdate` produces
              // the running total, the appended pass history and those three columns TOGETHER — there
              // is no way to write the figure here without recording the pass that made it, which is
              // what stops the next connector from reintroducing the same gap by omission.
              ...buildAllocationDebitOrderUpdate({
                existingAmount: order.allocationBatchAmount,
                existingPasses: order.allocationBatchPasses,
                passAmount: orderValues.get(order.id) ?? 0,
                syncLogId: a2JournalByOrderId.get(order.id)?.syncLogId ?? null,
                connector: XERO_CONNECTOR,
                accountCode: settings.xero_allocated_inventory_account,
                batchRef: a2JournalByOrderId.get(order.id)?.referenceId ?? '',
                at: new Date(),
              }),
            },
          })
        }

        return { count: accepted.length, hasMore: candidateWindow.hasMore, journals: a2PostedGroups }
      })

      for (const journal of groupA2.journals) await reportLockedPeriodMoves('A2', journal.date, journal.movedFromLockedDays, lockDate)
      negativeBasisRefusals.push(...passRefusals)
      for (const refusal of passRefusals) {
        if (refusal.detail.orderId) refusedA2OrderIds.add(refusal.detail.orderId)
      }
      a2Accepted += groupA2.count
      a2HasMore = groupA2.hasMore
      result.groupA2 = a2Accepted
      result.hasMore.groupA2 = a2HasMore
      if (passRefusals.length === 0 || !groupA2.hasMore) break
    }
  } catch (e) {
    result.errors.push(`Group A2 error: ${String(e)}`)
  }

  await runGroupB('paid')


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
      if (journal && !(await skipJournalInLockedPeriod('The inventory reconciliation sweep journal', journal.date, lockDate))) {
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
      if (journal && !(await skipJournalInLockedPeriod('The COGS reconciliation sweep journal', journal.date, lockDate))) {
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
      if (journal && !(await skipJournalInLockedPeriod('The transit reconciliation sweep journal', journal.date, lockDate))) {
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

    await stageGrirReclassJournals(settings, baseCurrency, dateContext, batchLimit, result)

    await reportNegativeBasisRefusals(result, negativeBasisRefusals)

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
