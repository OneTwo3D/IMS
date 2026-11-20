import { startOfNextBusinessDay } from '@/lib/domain/inventory/inventory-snapshot'
import { INVENTORY_SNAPSHOT_FLOOR_LOCK_KEY } from '@/lib/db/advisory-locks'

/**
 * THE INSTANT A WAREHOUSE DESPATCH IS BOOKED AT.
 *
 * A warehouse reports WHEN the goods left. IMS applies that report later: on the next 15-minute tick, after a coverage or
 * backorder refusal clears, after a dead-letter replay, after an outage. Dating the shipment by the apply clock moved a 23:50 despatch applied
 * at 00:05 into the next month, so period stock, COGS and despatch reporting were all wrong.
 *
 * ONE INSTANT, USED EVERYWHERE. The instant resolved here is what the dispatch transaction stamps on the shipment (`shippedAt`, which the
 * daily batch dates Group B revenue recognition and COGS by), on the order flip (`shippedAt`), on the SALE_DISPATCH stock movement
 * (`createdAt`, which every stock ledger, as-of valuation and snapshot replay windows by) and on its COGS entries. They can never disagree.
 * Group A2 (allocated-inventory reclassification) is dated by the allocation row, which is why the floor below includes it: Group B may
 * never be dated before A2.
 *
 * A BACKDATE IS BOUNDED. The reported instant is used as it stands, except where doing so would rewrite something already closed or
 * would be implausible. It is MOVED (never refused: the goods have left and the order must complete) to the nearest acceptable instant and
 * the move is recorded on the order (a WARNING activity entry naming both instants and the reason):
 *
 *   FUTURE            later than now (a warehouse clock ahead of ours): the apply instant.
 *   TOO_OLD           older than DESPATCH_BACKDATE_MAX_DAYS: not credible evidence of a recent despatch; the apply instant.
 *   LOCKED_PERIOD     on or before the Xero books lock date: the first instant after the lock (the daily batch does the same for a journal).
 *   SNAPSHOTTED_DAY   inside a business day whose inventory snapshot has already been taken: the first instant after that snapshot, so a
 *                     stored snapshot (and the replay anchored on it) is never made stale by a late movement.
 *                     The floor is read UNDER the inventory snapshot floor lock (shared), which the daily snapshot holds exclusive from its state read to
 *                     its run row: a despatch is wholly before the snapshot's read or reads the new floor (see lib/db/advisory-locks.ts).
 *   BEFORE_RECEIPT    before the receipt of a FIFO layer the despatch consumes: COGS must never be dated before the stock it consumes arrived (and a
 *                     negative-stock replay must not see the sale before the receipt): the latest receipt among the layers FIFO will take.
 *   LOCK_UNKNOWN      the stored accounting lock date is unreadable or was last read more than DESPATCH_LOCK_DATE_MAX_AGE_HOURS ago: not backdated at all
 *                     (booked at the apply instant), because a backdate into a period locked since could not be moved out of it.
 *   BEFORE_ALLOCATION before the stock was allocated to the shipment (Group B would be dated before Group A2: Allocated Inventory
 *                     would go negative at a period end): the allocation instant.
 *   BEFORE_ORDER      before the order existed in IMS: the order's creation instant.
 *
 * A floor is applied only when it is later than the reported instant, and the result never exceeds `now`.
 */

/** A despatch older than this is not backdated; it is booked at the apply instant. */
export const DESPATCH_BACKDATE_MAX_DAYS = 31

/** How far ahead of our own clock a warehouse timestamp may be before it counts as FUTURE (clock skew between systems). */
export const DESPATCH_FUTURE_TOLERANCE_MS = 5 * 60_000

/** A stored accounting lock date older than this is not trusted to bound a backdate (the daily batch refreshes it before every post). */
export const DESPATCH_LOCK_DATE_MAX_AGE_HOURS = 24

export type DespatchInstantAdjustment =
  | 'FUTURE'
  | 'TOO_OLD'
  | 'LOCKED_PERIOD'
  | 'SNAPSHOTTED_DAY'
  | 'BEFORE_ALLOCATION'
  | 'BEFORE_ORDER'
  | 'BEFORE_RECEIPT'
  | 'LOCK_UNKNOWN'

export type DespatchInstantFloors = {
  /** The first instant after the Xero books lock date, or null when no lock is known. */
  afterLock?: Date | null
  /** The cutoff of the latest inventory snapshot taken (nothing may be backdated before it), or null when none exists. */
  afterSnapshot?: Date | null
  /** The latest creation instant of the allocation rows behind the shipment, or null when unknown. */
  allocatedAt?: Date | null
  /** When the order was created in IMS, or null when unknown. */
  orderCreatedAt?: Date | null
  /** The latest receipt instant among the FIFO layers the despatch will consume, or null when unknown. */
  afterLayerReceipt?: Date | null
  /** True when the stored accounting lock date cannot be trusted (unparseable, or last read too long ago): the despatch is not backdated. */
  lockUnknown?: boolean
}

export type DespatchInstantResolution = {
  /** The instant to book the despatch at. */
  instant: Date
  /** The instant the warehouse reported, or null when it reported none usable (the apply instant is used, as before). */
  requested: Date | null
  /** Why `instant` differs from `requested`; null when it does not (or when none was reported). */
  adjustedFor: DespatchInstantAdjustment | null
}

export function resolveDespatchInstant(input: {
  requested: Date | null | undefined
  now: Date
  floors?: DespatchInstantFloors
}): DespatchInstantResolution {
  const { now } = input
  const requested = input.requested && !Number.isNaN(input.requested.getTime()) ? input.requested : null
  if (requested === null) return { instant: now, requested: null, adjustedFor: null }

  if (requested.getTime() > now.getTime()) {
    // Within the tolerance it is clock skew (booked at now, quietly); beyond it the move is named.
    const beyond = requested.getTime() - now.getTime() > DESPATCH_FUTURE_TOLERANCE_MS
    return { instant: now, requested, adjustedFor: beyond ? 'FUTURE' : null }
  }
  if (now.getTime() - requested.getTime() > DESPATCH_BACKDATE_MAX_DAYS * 86_400_000) {
    return { instant: now, requested, adjustedFor: 'TOO_OLD' }
  }

  const floors = input.floors ?? {}
  if (floors.lockUnknown) {
    // Not backdated at all: a period may have been locked since the stored date was read, and a journal dated inside it could not be moved out of it.
    return { instant: now, requested, adjustedFor: 'LOCK_UNKNOWN' }
  }
  const candidates: Array<[DespatchInstantAdjustment, Date | null | undefined]> = [
    ['BEFORE_ORDER', floors.orderCreatedAt],
    ['BEFORE_ALLOCATION', floors.allocatedAt],
    ['SNAPSHOTTED_DAY', floors.afterSnapshot],
    ['BEFORE_RECEIPT', floors.afterLayerReceipt],
    ['LOCKED_PERIOD', floors.afterLock],
  ]
  let instant = requested
  let adjustedFor: DespatchInstantAdjustment | null = null
  for (const [reason, floor] of candidates) {
    if (floor && !Number.isNaN(floor.getTime()) && floor.getTime() > instant.getTime()) {
      instant = floor
      adjustedFor = reason
    }
  }
  // A floor can sit ahead of now (a lock that reaches today): never book in the future.
  if (instant.getTime() > now.getTime()) instant = now
  return { instant, requested, adjustedFor }
}

/** The first instant after the books lock day `YYYY-MM-DD` (the last locked day, London business day), or null when absent or unreadable. */
export function instantAfterLockDay(lockDay: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((lockDay ?? '').trim())
  if (!match) return null
  const label = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (Number.isNaN(label.getTime()) || label.toISOString().slice(0, 10) !== match[0]) return null
  return startOfNextBusinessDay(label)
}

export type LockDateReading = { afterLock: Date | null; lockUnknown: boolean }

/**
 * What the STORED accounting lock date says, with the freshness rule made explicit.
 *   - No value stored and no read ever recorded: there is no accounting connector reading a lock, so there is NO lock (stated, not an accident of a falsy check).
 *   - A value that does not parse, or a read older than DESPATCH_LOCK_DATE_MAX_AGE_HOURS (or a value with no read time): UNKNOWN, so the despatch is not backdated.
 *   - An EMPTY value with a fresh read: the accounting system reported no lock.
 *   - A parseable value with a fresh read: the lock.
 */
export function readStoredLockDate(input: { value: string | null | undefined; readAt: string | null | undefined; now: Date }): LockDateReading {
  const value = (input.value ?? '').trim()
  const readAtRaw = (input.readAt ?? '').trim()
  if (value === '' && readAtRaw === '') return { afterLock: null, lockUnknown: false }
  const readAt = readAtRaw === '' ? null : new Date(readAtRaw)
  const fresh = readAt !== null && !Number.isNaN(readAt.getTime()) && input.now.getTime() - readAt.getTime() <= DESPATCH_LOCK_DATE_MAX_AGE_HOURS * 3_600_000
  if (!fresh) return { afterLock: null, lockUnknown: true }
  if (value === '') return { afterLock: null, lockUnknown: false }
  const afterLock = instantAfterLockDay(value)
  return afterLock === null ? { afterLock: null, lockUnknown: true } : { afterLock, lockUnknown: false }
}

type FloorClient = {
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
  $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>
  setting: { findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true } }): Promise<Array<{ key: string; value: string }>> }
  inventorySnapshotRun: {
    findFirst(args: { orderBy: { snapshotDate: 'desc' }; select: { snapshotDate: true; cutoffAt: true } }): Promise<{ snapshotDate: Date; cutoffAt: Date | null } | null>
  }
  orderAllocation: {
    aggregate(args: { where: { orderId: string; lineId?: { in: string[] } }; _max: { createdAt: true } }): Promise<{ _max: { createdAt: Date | null } }>
  }
  salesOrder: { findUnique(args: { where: { id: string }; select: { createdAt: true } }): Promise<{ createdAt: Date } | null> }
}

/**
 * TAKE THE INVENTORY SNAPSHOT FLOOR LOCK (SHARED), to the end of the caller's transaction. Taken BEFORE the snapshot floor is read, so the floor read here
 * is the floor the daily snapshot has committed, or the snapshot waits for this transaction to commit before it reads its state.
 */
export async function lockInventorySnapshotFloorShared(client: unknown): Promise<void> {
  await (client as FloorClient).$executeRaw`SELECT pg_advisory_xact_lock_shared(${INVENTORY_SNAPSHOT_FLOOR_LOCK_KEY})`
}

type LayerNeed = { productId: string; warehouseId: string; qty: number }

/** The latest receipt among the FIFO layers that cover each need (oldest first, as consumeFifoLayers takes them). Read-only; run after the stock levels are locked. */
async function latestConsumedLayerReceipt(tx: FloorClient, needs: ReadonlyArray<LayerNeed>): Promise<Date | null> {
  const byKey = new Map<string, LayerNeed>()
  for (const need of needs) {
    if (!(need.qty > 0)) continue
    const key = `${need.productId}:${need.warehouseId}`
    const current = byKey.get(key)
    byKey.set(key, { ...need, qty: (current?.qty ?? 0) + need.qty })
  }
  let latest: Date | null = null
  for (const need of byKey.values()) {
    const layers = await tx.$queryRaw<Array<{ remainingQty: unknown; receivedAt: Date }>>`
      SELECT "remainingQty", "receivedAt" FROM "cost_layers"
       WHERE "productId" = ${need.productId} AND "warehouseId" = ${need.warehouseId} AND "remainingQty" > 0
       ORDER BY "receivedAt" ASC, id ASC`
    let remaining = need.qty
    for (const layer of layers) {
      if (remaining <= 0) break
      remaining -= Number(layer.remainingQty)
      if (latest === null || layer.receivedAt.getTime() > latest.getTime()) latest = layer.receivedAt
    }
  }
  return latest
}

/**
 * The floors for one order, read on the dispatch transaction's own client (under the order lock). Read-only; no network. Takes the inventory snapshot floor
 * lock (shared) FIRST: call it only when a backdate was requested, and only inside the dispatch transaction.
 */
export async function loadDespatchInstantFloors(
  client: unknown,
  input: { orderId: string; lineIds: string[]; layerNeeds?: ReadonlyArray<LayerNeed>; now?: Date },
): Promise<DespatchInstantFloors> {
  const tx = client as FloorClient
  await lockInventorySnapshotFloorShared(tx)
  const [settings, run, allocation, order, layerReceipt] = await Promise.all([
    tx.setting.findMany({ where: { key: { in: ['xero_books_lock_date', 'xero_books_lock_date_read_at'] } }, select: { key: true, value: true } }),
    tx.inventorySnapshotRun.findFirst({ orderBy: { snapshotDate: 'desc' }, select: { snapshotDate: true, cutoffAt: true } }),
    tx.orderAllocation.aggregate({
      where: { orderId: input.orderId, ...(input.lineIds.length > 0 ? { lineId: { in: input.lineIds } } : {}) },
      _max: { createdAt: true },
    }),
    tx.salesOrder.findUnique({ where: { id: input.orderId }, select: { createdAt: true } }),
    input.layerNeeds && input.layerNeeds.length > 0 ? latestConsumedLayerReceipt(tx, input.layerNeeds) : Promise.resolve(null),
  ])
  const stored = new Map(settings.map((row) => [row.key, row.value]))
  const lock = readStoredLockDate({ value: stored.get('xero_books_lock_date'), readAt: stored.get('xero_books_lock_date_read_at'), now: input.now ?? new Date() })
  return {
    afterLock: lock.afterLock,
    lockUnknown: lock.lockUnknown,
    afterSnapshot: run ? (run.cutoffAt ?? startOfNextBusinessDay(run.snapshotDate)) : null,
    allocatedAt: allocation._max.createdAt ?? null,
    orderCreatedAt: order?.createdAt ?? null,
    afterLayerReceipt: layerReceipt,
  }
}

export function describeDespatchAdjustment(resolution: DespatchInstantResolution): string | null {
  if (!resolution.adjustedFor || !resolution.requested) return null
  const reason: Record<DespatchInstantAdjustment, string> = {
    FUTURE: 'it is later than the current time',
    TOO_OLD: `it is more than ${DESPATCH_BACKDATE_MAX_DAYS} days old`,
    LOCKED_PERIOD: 'it falls in a period locked in the accounting system',
    SNAPSHOTTED_DAY: 'its day already has an inventory snapshot',
    BEFORE_ALLOCATION: 'it is earlier than the stock allocation behind the shipment',
    BEFORE_ORDER: 'it is earlier than the order itself',
    BEFORE_RECEIPT: 'it is earlier than the receipt of the stock it consumed',
    LOCK_UNKNOWN: 'the accounting system\'s locked period could not be confirmed recently, so it was not backdated',
  }
  return `The warehouse reported this despatch at ${resolution.requested.toISOString()}, but it was booked at ${resolution.instant.toISOString()} because ${reason[resolution.adjustedFor]}.`
}
