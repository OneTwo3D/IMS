/**
 * THE ROLLBACK HAND-BACK (`npm run switchover:hand-back`, design o3d-zvec.3 step M rollback).
 *
 * When step M is rolled back the bridge resumes. Its second pass only covers orders that carry `_mintsoft_order_id`, so an OPEN WooCommerce order that IMS
 * created in Mintsoft (and so has no such meta) would have no writer at all. This writes the bridge's two link metas, `_mintsoft_order_id` and
 * `_mintsoft_order_number`, onto each of them so the bridge adopts the Mintsoft order IMS made instead of creating a second one.
 *
 * WHICH ORDERS: IMS holds a Mintsoft link with an id and the link was made by IMS at or after S (a link adopted from the bridge before S carries the metas
 * already), the order is still open (not cancelled or completed in IMS, and not completed, cancelled, refunded or failed on the storefront) and has a WooCommerce link.
 *
 * READ BEFORE WRITE, ONE ORDER AT A TIME. The storefront order is read first: a closed one is skipped; one that already carries BOTH metas with the same values
 * is left alone (an absolute write would be harmless, but nothing is sent for nothing); one that carries a DIFFERENT value is a CONFLICT and is never overwritten
 * (a person decides). A DRY RUN is the default and writes nothing; `--apply` sends. The write is `PUT /orders/{id}` with the two metas, through the ordinary
 * WooCommerce write client, so the producer-side hold applies to it: run it while the step-M configuration is still in place and IMS's other writers are stopped.
 */

export const BRIDGE_ORDER_ID_META = '_mintsoft_order_id'
export const BRIDGE_ORDER_NUMBER_META = '_mintsoft_order_number'
/** Storefront statuses at which an order is no longer open. */
const CLOSED_STOREFRONT_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'refunded', 'failed', 'trash', 'withdrawn'])
const OPEN_IMS_STATUSES = ['PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'ON_HOLD', 'SHIPPED'] as const

export type HandBackCandidate = { orderId: string; reference: string; storefrontId: string; mintsoftOrderId: string; mintsoftOrderNumber: string }

type CandidateDb = {
  wmsOrderPushLink: {
    findMany(args: unknown): Promise<Array<{ externalOrderId: string | null; externalOrderNumber: string | null; order: { id: string; orderNumber: string | null; externalOrderNumber: string | null; shoppingLinks: Array<{ externalOrderId: string }> } }>>
  }
}

export async function listHandBackCandidates(input: { since: Date; db: CandidateDb }): Promise<HandBackCandidate[]> {
  const links = await input.db.wmsOrderPushLink.findMany({
    where: {
      connector: 'mintsoft',
      externalOrderId: { not: null },
      // Made by IMS: the link's own creation time is at or after S (adopted bridge orders were linked before S, or carry the metas already).
      createdAt: { gte: input.since },
      state: { in: ['PENDING_VERIFY', 'SYNCED', 'HELD', 'PENDING_CANCEL'] },
      order: { status: { in: [...OPEN_IMS_STATUSES] }, erasedAt: null, shoppingLinks: { some: { connector: 'woocommerce' } } },
    },
    select: { externalOrderId: true, externalOrderNumber: true, order: { select: { id: true, orderNumber: true, externalOrderNumber: true, shoppingLinks: { where: { connector: 'woocommerce' }, select: { externalOrderId: true }, take: 1 } } } },
    orderBy: { createdAt: 'asc' },
  })
  return links.flatMap((link) => {
    const storefront = link.order.shoppingLinks[0]
    if (!storefront || !link.externalOrderId) return []
    const reference = link.order.orderNumber ?? link.order.externalOrderNumber ?? link.order.id
    return [{ orderId: link.order.id, reference, storefrontId: storefront.externalOrderId, mintsoftOrderId: link.externalOrderId, mintsoftOrderNumber: link.externalOrderNumber ?? reference }]
  })
}

export type HandBackOutcome = 'written' | 'would-write' | 'already-set' | 'closed' | 'conflict' | 'unreadable' | 'held' | 'failed'
export type HandBackDeps = {
  /** The storefront order (a read): status and the two metas. Null = could not be read. */
  readOrder(storefrontId: string): Promise<{ status: string; metas: Record<string, string | null> } | null>
  /** The ONE write. `held` means the producer-side hold kept it. */
  writeMetas(storefrontId: string, metas: Record<string, string>): Promise<{ ok: boolean; held?: boolean }>
}

export async function handBackOne(candidate: HandBackCandidate, apply: boolean, deps: HandBackDeps): Promise<HandBackOutcome> {
  const order = await deps.readOrder(candidate.storefrontId)
  if (!order) return 'unreadable'
  if (CLOSED_STOREFRONT_STATUSES.has(order.status)) return 'closed'
  const wanted = { [BRIDGE_ORDER_ID_META]: candidate.mintsoftOrderId, [BRIDGE_ORDER_NUMBER_META]: candidate.mintsoftOrderNumber }
  let missing = false
  for (const [key, value] of Object.entries(wanted)) {
    const current = order.metas[key]
    if (current === undefined || current === null || current === '') missing = true
    else if (current !== value) return 'conflict'
  }
  if (!missing) return 'already-set'
  if (!apply) return 'would-write'
  const result = await deps.writeMetas(candidate.storefrontId, wanted)
  return result.held ? 'held' : result.ok ? 'written' : 'failed'
}

export async function runHandBack(candidates: readonly HandBackCandidate[], apply: boolean, deps: HandBackDeps): Promise<{ counts: Record<HandBackOutcome, number>; results: Array<{ reference: string; outcome: HandBackOutcome }> }> {
  const counts: Record<HandBackOutcome, number> = { written: 0, 'would-write': 0, 'already-set': 0, closed: 0, conflict: 0, unreadable: 0, held: 0, failed: 0 }
  const results: Array<{ reference: string; outcome: HandBackOutcome }> = []
  for (const candidate of candidates) {
    const outcome = await handBackOne(candidate, apply, deps)
    counts[outcome] += 1
    results.push({ reference: candidate.reference, outcome })
    // A held write means the hold stands for every order: stop at the first instead of asking the store about all the rest.
    if (outcome === 'held') break
  }
  return { counts, results }
}
