/**
 * THE SWITCHOVER GAP LIST AND THE PER-ORDER TAKE-OVER (`npm run switchover:gaps`, design o3d-zvec.3 sections 4 and 5).
 *
 * The bridge stops at instant S and IMS goes live from S. Work whose business event falls BEFORE S and that the bridge did not finish has no writer: IMS
 * shadows it for good (`obligation_before_cutoff`). Two kinds, listed here so nothing is lost:
 *
 *   G_create    orders paid before S that IMS holds no Mintsoft link for and that are still wanted (ready, not fully refunded, no withdrawal): the bridge
 *               never created them in Mintsoft.
 *   G_despatch  orders IMS knows are SHIPPED (a Mintsoft despatch before S, inside the look-back window) whose STOREFRONT order is not completed or carries no
 *               tracking: the bridge's last pass missed them. Every candidate's storefront order is READ (paced), and only an order that is not completed with
 *               tracking is listed; one that cannot be read is listed too (marked unreadable): it cannot be shown to be complete. Not every shipped order.
 *
 * THE TAKE-OVER closes one order at a time and READS BEFORE IT WRITES:
 *   G_create    searches Mintsoft by the order's number first. Found as ONE order: IMS adopts it (a link in PENDING_VERIFY, which the push sweep verifies is
 *               ours; nothing is sent to Mintsoft). Found as several parts: refused (a split or merged order is imported by the legacy-state import).
 *               Not found: refused with the instruction to create it in Mintsoft by hand and run the take-over again; IMS never creates an order paid
 *               before S itself (that is what the floor is for).
 *   G_despatch  reads the storefront order first. Already completed with tracking: nothing to write. Otherwise it queues the ordinary completion job (idempotent per order and S) with
 *               the obligation time NOW (the job re-reads the storefront before it sends anything, and the producer-side hold keeps it shadowed until the
 *               step is live).
 * Both default to a DRY RUN that does the reads and writes nothing; `--apply` writes.
 *
 * Reads only through the connectors' own read clients; the module itself calls no write function of Mintsoft or WooCommerce.
 */
import { WMS_CREATE_ELIGIBLE_ORDER_FENCES, WMS_CREATE_READY_STATUSES } from '@/lib/domain/wms/create-eligibility'

export const GAP_KINDS = ['G_create', 'G_despatch'] as const
export type GapKind = (typeof GAP_KINDS)[number]

export type GapOrder = { orderId: string; reference: string; kind: GapKind; at: Date; /** G_despatch only: the storefront order could not be read. */ unreadable?: boolean }

export type StorefrontState = { status: string; trackingItems: number }

type GapDb = {
  salesOrder: {
    findMany(args: unknown): Promise<Array<{ id: string; orderNumber: string | null; externalOrderNumber: string | null; paidAt: Date | null; shippedAt: Date | null; shoppingLinks?: Array<{ externalOrderId: string }> }>>
  }
}

const LIST_LIMIT = 5000
/** How far before S a despatch is looked at: the bridge's last sweep completed everything older. */
export const GAP_DESPATCH_WINDOW_DAYS = 14
/** The pause between two storefront reads of the G_despatch filter (the storefront shares its PHP pool with customers). */
const STOREFRONT_READ_PAUSE_MS = 250
const reference = (order: { id: string; orderNumber: string | null; externalOrderNumber: string | null }) => order.orderNumber ?? order.externalOrderNumber ?? order.id

export async function listSwitchoverGaps(input: {
  since: Date
  db: GapDb
  /** The storefront order (a read). Null = could not be read. */
  readStorefront: (externalOrderId: string) => Promise<StorefrontState | null>
  windowDays?: number
  pauseMs?: number
}): Promise<{ create: GapOrder[]; despatch: GapOrder[]; truncated: boolean }> {
  const windowStart = new Date(input.since.getTime() - (input.windowDays ?? GAP_DESPATCH_WINDOW_DAYS) * 86_400_000)
  const create = await input.db.salesOrder.findMany({
    where: {
      ...WMS_CREATE_ELIGIBLE_ORDER_FENCES,
      paidAt: { not: null, lt: input.since },
      erasedAt: null,
      shoppingLinks: { some: { connector: 'woocommerce' } },
      // Unlinked: no push link at all, or one that never got a Mintsoft id and is not cancelled.
      OR: [{ wmsOrderPush: { is: null } }, { wmsOrderPush: { is: { externalOrderId: null, state: { in: ['PENDING_CREATE', 'DEAD_LETTER', 'HELD'] } } } }],
    },
    select: { id: true, orderNumber: true, externalOrderNumber: true, paidAt: true, shippedAt: true },
    orderBy: { paidAt: 'asc' },
    take: LIST_LIMIT,
  })
  const despatch = await input.db.salesOrder.findMany({
    where: {
      status: 'SHIPPED',
      erasedAt: null,
      shoppingLinks: { some: { connector: 'woocommerce' } },
      refundStatus: { not: 'FULL' },
      // A row with no shippedAt is listed when it was created before S and touched inside the window (updatedAt >= window start): an old backorder despatched
      // just before S with no shippedAt stays in, while untouched history does not cost a storefront read each.
      OR: [{ shippedAt: { gte: windowStart, lt: input.since } }, { shippedAt: null, createdAt: { lt: input.since }, updatedAt: { gte: windowStart } }],
    },
    select: { id: true, orderNumber: true, externalOrderNumber: true, paidAt: true, shippedAt: true, shoppingLinks: { where: { connector: 'woocommerce' }, select: { externalOrderId: true }, take: 1 } },
    orderBy: { shippedAt: 'asc' },
    take: LIST_LIMIT,
  })
  // Keep only the orders whose storefront order is still open: completed (with or without tracking: a letter-post or collection despatch has none),
  // refunded and cancelled storefront orders are closed, not gaps.
  const pause = input.pauseMs ?? STOREFRONT_READ_PAUSE_MS
  const gapDespatch: Array<{ row: (typeof despatch)[number]; unreadable: boolean }> = []
  let reads = 0
  for (const row of despatch) {
    const link = row.shoppingLinks?.[0]
    if (!link) continue
    if (pause > 0 && reads > 0) await new Promise((resolve) => setTimeout(resolve, pause))
    reads += 1
    const store = await input.readStorefront(link.externalOrderId)
    if (store && STOREFRONT_CLOSED_STATUSES.has(store.status)) continue
    gapDespatch.push({ row, unreadable: store === null })
  }
  return {
    create: create.map((o) => ({ orderId: o.id, reference: reference(o), kind: 'G_create' as const, at: o.paidAt! })),
    despatch: gapDespatch.map(({ row: o, unreadable }) => ({ orderId: o.id, reference: reference(o), kind: 'G_despatch' as const, at: o.shippedAt ?? new Date(0), ...(unreadable ? { unreadable: true } : {}) })),
    truncated: create.length >= LIST_LIMIT || despatch.length >= LIST_LIMIT,
  }
}

/** A storefront order in one of these states needs no despatch written to it. */
const STOREFRONT_CLOSED_STATUSES: ReadonlySet<string> = new Set(['completed', 'refunded', 'cancelled'])

export type TakeOverResult =
  | { outcome: 'adopted' | 'would-adopt'; kind: 'G_create'; externalOrderId: string }
  | { outcome: 'queued' | 'would-queue'; kind: 'G_despatch' }
  | { outcome: 'nothing-to-do'; kind: GapKind; why: string }
  | { outcome: 'refused'; kind: GapKind | null; why: string }

export type TakeOverDeps = {
  db: {
    salesOrder: { findUnique(args: unknown): Promise<{ id: string; status: string; refundStatus?: string | null; paymentRemovedForeign?: unknown; withdrawalHoldAt?: Date | null; withdrawalApprovedAt?: Date | null; erasedAt?: Date | null; orderNumber: string | null; externalOrderNumber: string | null; paidAt: Date | null; shippedAt: Date | null; shipFromWarehouseId: string | null; shoppingLinks: Array<{ externalOrderId: string }>; wmsOrderPush: { externalOrderId: string | null; state: string } | null } | null> }
    wmsOrderPushLink: { upsert(args: unknown): Promise<unknown> }
    $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>
  }
  clientId: number
  /** The Mintsoft parts of an order number (a read). */
  fetchParts(orderNumber: string, clientId: number): Promise<Array<{ externalId: string }>>
  /** The storefront order (a read): its status and how many tracking items it carries. Null = could not be read. */
  readStorefrontOrder(externalOrderId: string): Promise<{ status: string; trackingItems: number } | null>
  /** Queue the completion job with this obligation time inside the transaction; null when the hold shadowed it. */
  queueCompletion(tx: unknown, input: { orderId: string; at: Date; keyPart: string }): Promise<string | null>
  now?: () => Date
}

/** Close ONE gap order. `apply` false = a dry run (the reads happen, nothing is written). */
export async function takeOverGapOrder(orderId: string, since: Date, apply: boolean, deps: TakeOverDeps): Promise<TakeOverResult> {
  const order = await deps.db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, refundStatus: true, paymentRemovedForeign: true, withdrawalHoldAt: true, withdrawalApprovedAt: true, erasedAt: true, orderNumber: true, externalOrderNumber: true, paidAt: true, shippedAt: true, shipFromWarehouseId: true, shoppingLinks: { where: { connector: 'woocommerce' }, select: { externalOrderId: true }, take: 1 }, wmsOrderPush: { select: { externalOrderId: true, state: true } } },
  })
  if (!order) return { outcome: 'refused', kind: null, why: 'No such order in IMS.' }
  const now = (deps.now ?? (() => new Date()))()

  if (order.status === 'SHIPPED') {
    // G_despatch: the despatch is known to IMS, the storefront may not have it.
    if (order.shippedAt && order.shippedAt.getTime() >= since.getTime()) return { outcome: 'refused', kind: 'G_despatch', why: 'The despatch is at or after S: IMS owns it, it is not a gap.' }
    const link = order.shoppingLinks[0]
    if (!link) return { outcome: 'refused', kind: 'G_despatch', why: 'The order has no WooCommerce link.' }
    const store = await deps.readStorefrontOrder(link.externalOrderId)
    if (!store) return { outcome: 'refused', kind: 'G_despatch', why: 'The storefront order could not be read, so nothing was written.' }
    if (STOREFRONT_CLOSED_STATUSES.has(store.status)) return { outcome: 'nothing-to-do', kind: 'G_despatch', why: `The storefront order is already ${store.status}: nothing to complete.` }
    if (!apply) return { outcome: 'would-queue', kind: 'G_despatch' }
    // A STABLE key per (order, S): repeating --apply finds the job it already queued instead of queueing another. The obligation time stays NOW.
    const key = await deps.db.$transaction((tx) => deps.queueCompletion(tx, { orderId, at: now, keyPart: `takeover:${since.getTime()}` }))
    return key === null
      ? { outcome: 'refused', kind: 'G_despatch', why: 'The producer-side hold kept the completion as a shadow (step M is not live, or the order has no link): nothing was queued.' }
      : { outcome: 'queued', kind: 'G_despatch' }
  }

  // G_create.
  if (order.paidAt === null || order.paidAt.getTime() >= since.getTime()) return { outcome: 'refused', kind: 'G_create', why: 'The order was not paid before S: IMS creates it itself, it is not a gap.' }
  // Re-check, at the instant of the take-over, that the order is STILL wanted: it may have been cancelled, refunded, erased or withdrawal-held since the list was taken.
  const stillWanted = (WMS_CREATE_READY_STATUSES as readonly string[]).includes(order.status)
    && order.refundStatus !== 'FULL' && !order.paymentRemovedForeign && !order.withdrawalHoldAt && !order.withdrawalApprovedAt && !order.erasedAt
  if (!stillWanted) return { outcome: 'refused', kind: 'G_create', why: `The order is no longer eligible to be created (status ${order.status}, a refund, withdrawal, erasure or removed payment): nothing was adopted.` }
  if (order.wmsOrderPush?.externalOrderId) return { outcome: 'nothing-to-do', kind: 'G_create', why: 'IMS already holds a Mintsoft link for this order.' }
  const parts = await deps.fetchParts(reference(order), deps.clientId)
  if (parts.length === 0) return { outcome: 'refused', kind: 'G_create', why: 'Mintsoft has no order with this number. IMS does not create an order paid before S: create it in Mintsoft by hand, then run the take-over again.' }
  if (parts.length > 1) return { outcome: 'refused', kind: 'G_create', why: `Mintsoft holds ${parts.length} parts for this number (a split or merged order): import it with the legacy-state import, not here.` }
  const externalOrderId = parts[0]!.externalId
  if (!apply) return { outcome: 'would-adopt', kind: 'G_create', externalOrderId }
  await deps.db.wmsOrderPushLink.upsert({
    where: { orderId },
    create: { orderId, connector: 'mintsoft', externalOrderId, externalOrderNumber: reference(order), state: 'PENDING_VERIFY', pushedAt: now, pushWarehouseId: order.shipFromWarehouseId },
    // A link that exists has no Mintsoft id yet (checked above): point it at the order Mintsoft holds and let the sweep verify it is ours.
    update: { externalOrderId, externalOrderNumber: reference(order), state: 'PENDING_VERIFY', pushedAt: now, pushWarehouseId: order.shipFromWarehouseId },
  })
  return { outcome: 'adopted', kind: 'G_create', externalOrderId }
}
