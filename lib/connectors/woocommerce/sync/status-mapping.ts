/**
 * ONE READING OF A WOOCOMMERCE STATUS STRING (o3d-tj6v r4).
 *
 * The admission boundary normalises: `normaliseWcOrderStatus` lowercases and strips a leading
 * `wc-`, so an operator who typed `wc-on-hold` into the status selection and a store that reports
 * `on-hold` are talking about the same status. The paths BEHIND that boundary did not, and that is
 * finding 4. They compared raw strings:
 *
 *   - `shoppingStatusMapping.findUnique({ externalStatus: wcOrder.status })`. The mapping table is
 *     keyed on whatever an operator typed into the Sync page; WooCommerce always reports the bare
 *     slug. A row saved as `wc-completed` therefore never matched, and the two callers fail in
 *     opposite directions — `importWcOrder` silently defaults the new order to PROCESSING, while
 *     `syncWcOrderStatus` treats "no mapping" as "ignore this status" and never syncs it at all.
 *   - `wcOrder.status === 'completed'` / `=== 'refunded'`, which decide whether the completion flow
 *     runs and whether refunds are left to the refund sync.
 *
 * So an order could be ADMITTED by a normalised comparison and then handled by a path that did not
 * recognise the very same string. The fix has two halves, and both make the DATA say one thing
 * rather than adding a second comparison:
 *
 *   WRITE  `upsertShoppingStatusMapping` normalises before it stores, so the table converges on the
 *          canonical slug and new rows can only ever be canonical.
 *   READ   this lookup asks for the canonical slug and its `wc-` spelling, case-insensitively, in
 *          ONE query — so the rows already stored under an older spelling keep working without a
 *          backfill, and without every caller growing its own fallback ladder.
 */

import type { SalesOrderStatus } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { normaliseWcOrderStatus } from '../order-status-filter'

export type WcStatusMapping = { externalStatus: string; imsStatus: SalesOrderStatus }

export async function findWcStatusMapping(status: unknown): Promise<WcStatusMapping | null> {
  const normalised = normaliseWcOrderStatus(status)
  if (!normalised) return null
  const rows = await db.shoppingStatusMapping.findMany({
    where: {
      connector: 'woocommerce',
      OR: [
        { externalStatus: { equals: normalised, mode: 'insensitive' } },
        { externalStatus: { equals: `wc-${normalised}`, mode: 'insensitive' } },
      ],
    },
    select: { externalStatus: true, imsStatus: true },
  })
  if (rows.length === 0) return null
  // Deterministic when a store holds both spellings: the canonical one wins, so two callers reading
  // the same status can never resolve it differently.
  return rows.find((row) => row.externalStatus === normalised)
    ?? rows.find((row) => normaliseWcOrderStatus(row.externalStatus) === normalised)
    ?? rows[0]
}

/** WooCommerce statuses this connector treats specially, compared the same normalised way. */
export function isWcStatus(status: unknown, slug: string): boolean {
  return normaliseWcOrderStatus(status) === normaliseWcOrderStatus(slug)
}
