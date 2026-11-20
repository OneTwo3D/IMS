import { startOfNextBusinessDay } from '@/lib/domain/inventory/inventory-snapshot'

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

export type DespatchInstantAdjustment =
  | 'FUTURE'
  | 'TOO_OLD'
  | 'LOCKED_PERIOD'
  | 'SNAPSHOTTED_DAY'
  | 'BEFORE_ALLOCATION'
  | 'BEFORE_ORDER'

export type DespatchInstantFloors = {
  /** The first instant after the Xero books lock date, or null when no lock is known. */
  afterLock?: Date | null
  /** The cutoff of the latest inventory snapshot taken (nothing may be backdated before it), or null when none exists. */
  afterSnapshot?: Date | null
  /** The latest creation instant of the allocation rows behind the shipment, or null when unknown. */
  allocatedAt?: Date | null
  /** When the order was created in IMS, or null when unknown. */
  orderCreatedAt?: Date | null
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
  const candidates: Array<[DespatchInstantAdjustment, Date | null | undefined]> = [
    ['BEFORE_ORDER', floors.orderCreatedAt],
    ['BEFORE_ALLOCATION', floors.allocatedAt],
    ['SNAPSHOTTED_DAY', floors.afterSnapshot],
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

type FloorClient = {
  setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> }
  inventorySnapshotRun: {
    findFirst(args: { orderBy: { snapshotDate: 'desc' }; select: { snapshotDate: true; cutoffAt: true } }): Promise<{ snapshotDate: Date; cutoffAt: Date | null } | null>
  }
  orderAllocation: {
    aggregate(args: { where: { orderId: string; lineId?: { in: string[] } }; _max: { createdAt: true } }): Promise<{ _max: { createdAt: Date | null } }>
  }
  salesOrder: { findUnique(args: { where: { id: string }; select: { createdAt: true } }): Promise<{ createdAt: Date } | null> }
}

/** The floors for one order, read on the dispatch transaction's own client (under the order lock). Read-only; no network. */
export async function loadDespatchInstantFloors(
  client: unknown,
  input: { orderId: string; lineIds: string[] },
): Promise<DespatchInstantFloors> {
  const tx = client as FloorClient
  const [lock, run, allocation, order] = await Promise.all([
    tx.setting.findUnique({ where: { key: 'xero_books_lock_date' }, select: { value: true } }),
    tx.inventorySnapshotRun.findFirst({ orderBy: { snapshotDate: 'desc' }, select: { snapshotDate: true, cutoffAt: true } }),
    tx.orderAllocation.aggregate({
      where: { orderId: input.orderId, ...(input.lineIds.length > 0 ? { lineId: { in: input.lineIds } } : {}) },
      _max: { createdAt: true },
    }),
    tx.salesOrder.findUnique({ where: { id: input.orderId }, select: { createdAt: true } }),
  ])
  return {
    afterLock: instantAfterLockDay(lock?.value),
    afterSnapshot: run ? (run.cutoffAt ?? startOfNextBusinessDay(run.snapshotDate)) : null,
    allocatedAt: allocation._max.createdAt ?? null,
    orderCreatedAt: order?.createdAt ?? null,
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
  }
  return `The warehouse reported this despatch at ${resolution.requested.toISOString()}, but it was booked at ${resolution.instant.toISOString()} because ${reason[resolution.adjustedFor]}.`
}
