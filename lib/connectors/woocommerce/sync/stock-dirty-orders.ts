import { randomUUID } from 'node:crypto'
import { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import { WC_SETTINGS_VERSION_KEY, WC_SYNC_ADVISORY_LOCK_KEY } from '../sync-lock'
import type { DirtyOrderSnapshot, HeldLine } from './stock-held-orders'

/**
 * THE DIRTY-ORDER RECORD. The covered-history boundary (stock-held-orders.ts) lets the stock guard omit an old completed order because IMS
 * holds its allocation. When IMS then deletes the order or releases/reduces its allocation, a stock push offers the freed units and restores
 * what WooCommerce already sold. Rotating the boundary would force an exhaustive completed read, which on a store past the walk ceiling can
 * never complete, so instead the released ORDER is recorded here, in the same transaction as the release, and the guard re-fetches exactly
 * those orders by id on every run (the boundary keeps bounding the bulk read). Shipping is not recorded: dispatch consumes the reservation
 * through the shipment, available stock does not rise.
 *
 * Call it INSIDE the releasing transaction; for a delete, BEFORE the order (and its link) is removed, which is where the WooCommerce order id
 * is captured. An order with no WooCommerce link is not recorded: WooCommerce holds nothing for it.
 */
export async function markWcOrderDirtyForStockGuard(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const link = await tx.shoppingOrderLink.findFirst({
    where: { orderId, connector: 'woocommerce' },
    select: { externalOrderId: true },
  })
  if (!link) return
  // The order id belongs to the store bound NOW: the entry carries the connection generation, so a later rebind (which retires the entries of
  // the old generation in its own transaction) can never leave it charging another store's order. A stale snapshot from an older generation is
  // dropped when the entry is re-bound.
  const version = (await tx.setting.findUnique({ where: { key: WC_SETTINGS_VERSION_KEY }, select: { value: true } }))?.value ?? '0'
  const token = randomUUID()
  const existing = await tx.wcStockDirtyOrder.findUnique({ where: { wcOrderId: link.externalOrderId }, select: { syncVersion: true } })
  const sameStore = existing?.syncVersion === version
  await tx.wcStockDirtyOrder.upsert({
    where: { wcOrderId: link.externalOrderId },
    create: { wcOrderId: link.externalOrderId, orderId, token, syncVersion: version },
    update: { orderId, token, releasedAt: new Date(), syncVersion: version, ...(sameStore ? {} : { lines: Prisma.DbNull, lineStatus: null, checkedAt: null }) },
  })
}

type DirtyDb = { $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> }

/** A stored snapshot read back, or null when it is not a well-formed list of lines (then the entry counts as never read). */
export function parseDirtySnapshot(lines: unknown, status: string | null): { status: string; lines: HeldLine[] } | null {
  if (!Array.isArray(lines) || !status) return null
  const out: HeldLine[] = []
  for (const l of lines as Array<Record<string, unknown>>) {
    const quantity = Number(l?.quantity)
    if (!Number.isFinite(quantity)) return null
    out.push({ productId: Number(l.productId) || 0, variationId: Number(l.variationId) || 0, sku: typeof l.sku === 'string' ? l.sku : '', quantity })
  }
  return { status, lines: out }
}

/** The entries of the CURRENT generation, never-read first and then least recently read (see DIRTY ORDERS in stock-held-orders.ts). */
export async function loadDirtyOrdersForGuard(database: Pick<typeof db, 'wcStockDirtyOrder'>, syncVersion: string) {
  return database.wcStockDirtyOrder.findMany({
    where: { syncVersion },
    orderBy: [{ checkedAt: { sort: 'asc', nulls: 'first' } }, { releasedAt: 'asc' }, { id: 'asc' }],
    select: { wcOrderId: true, token: true, lines: true, lineStatus: true, checkedAt: true },
  })
}

/**
 * Write back what a guard run learned, under the credential-mutation lock and ONLY if the connection generation is still the one the run began
 * under (a run for a store that has since been rebound writes nothing; the rebind itself retires the old generation's entries in its own
 * transaction, and any left by a release that raced it are removed here). Each write is a compare-and-set on the entry's token, so a release
 * made during the run replaces the token and is never cleared or overwritten. Returns false when the generation moved.
 */
export async function commitDirtyOrderOutcome(
  database: DirtyDb,
  syncVersion: string,
  outcome: { tokenOf: ReadonlyMap<string, string>; settled: readonly string[]; refreshed: readonly DirtyOrderSnapshot[] },
): Promise<boolean> {
  return database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
    const current = (await tx.setting.findUnique({ where: { key: WC_SETTINGS_VERSION_KEY }, select: { value: true } }))?.value ?? '0'
    if (current !== syncVersion) return false
    await tx.wcStockDirtyOrder.deleteMany({ where: { syncVersion: { not: current } } })
    for (const wcOrderId of outcome.settled) {
      const token = outcome.tokenOf.get(wcOrderId)
      if (token !== undefined) await tx.wcStockDirtyOrder.deleteMany({ where: { wcOrderId, token, syncVersion } })
    }
    const now = new Date()
    for (const r of outcome.refreshed) {
      const token = outcome.tokenOf.get(r.wcOrderId)
      if (token === undefined) continue
      await tx.wcStockDirtyOrder.updateMany({
        where: { wcOrderId: r.wcOrderId, token, syncVersion },
        data: { lines: r.lines as unknown as Prisma.InputJsonValue, lineStatus: r.status, checkedAt: now },
      })
    }
    return true
  })
}
