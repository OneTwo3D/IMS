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
 *
 * ROUND 5 FINISHES IT. Round 4 gave the two readers one LOOKUP and left them with two ANSWERS —
 * the silent `?? 'PROCESSING'` on one side and "no mapping = ignore" on the other were both still
 * there, so a status with no row was still read two different ways. `readWcOrderStatus` below is
 * the single answer: canonical slug, the operator's row, the built-in default WooCommerce's own
 * statuses have always had, and the special-case classification. Admission, creation and the
 * status sync all consume it, so "what status is this?" has exactly one reading.
 */

import type { SalesOrderStatus } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { normaliseWcOrderStatus } from '../order-status-filter'

export type WcStatusMapping = { externalStatus: string; imsStatus: SalesOrderStatus }

/**
 * WHAT WOOCOMMERCE'S OWN STATUSES MEAN, when the mapping table does not say (o3d-tj6v r5).
 *
 * These are the exact rows the schema seeds on install
 * (prisma/migrations/20260406200000_add_wc_sync_mappings, with `refunded` repointed to PROCESSING
 * by 20260628012324 when the REFUNDED lifecycle status was retired). They lived ONLY in that
 * migration, so a row an operator deleted — or a store whose install predates a status — left the
 * connector with no reading at all, and the two readers then invented DIFFERENT answers:
 *
 *   creation      `?? 'PROCESSING'`. A `cancelled` order with no row was created as PROCESSING,
 *                 which auto-allocates stock and queues an accounting invoice for an order the
 *                 customer cancelled.
 *   status sync   "no mapping = ignore this status", so the same order, arriving as an update,
 *                 was left alone.
 *
 * Round 4 gave the two a shared LOOKUP and left them with different ANSWERS. Having the defaults
 * here means there is one answer, both consume it, and a deleted row degrades to the documented
 * default instead of to whichever invention the caller happened to carry.
 */
export const WC_BUILT_IN_STATUS_MAP: Readonly<Record<string, SalesOrderStatus>> = {
  pending: 'PENDING_PAYMENT',
  failed: 'PENDING_PAYMENT',
  'on-hold': 'ON_HOLD',
  processing: 'PROCESSING',
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
  // Refund state is the orthogonal RefundDisposition, never the lifecycle status (o3d-w00).
  refunded: 'PROCESSING',
}

/**
 * ONE reading of a WooCommerce status, consumed by all three readers.
 *
 * `slug` is the canonical spelling — the only one anything compares. `imsStatus` is null ONLY for
 * a status this connector has no reading of at all: a custom storefront status with no mapping
 * row and no built-in default. Both readers must then say "I do not know this status" rather than
 * each inventing its own answer, which is what finding 4 names.
 */
export type WcOrderStatusReading = {
  slug: string
  mapping: WcStatusMapping | null
  imsStatus: SalesOrderStatus | null
  source: 'mapping' | 'built-in' | 'unknown'
  /** Statuses this connector deliberately handles OUTSIDE the ordinary lifecycle transition. */
  handledBy: 'completion-flow' | 'refund-sync' | null
}

export async function readWcOrderStatus(status: unknown): Promise<WcOrderStatusReading> {
  const slug = normaliseWcOrderStatus(status)
  const mapping = await findWcStatusMapping(slug)
  const builtIn = Object.prototype.hasOwnProperty.call(WC_BUILT_IN_STATUS_MAP, slug)
    ? WC_BUILT_IN_STATUS_MAP[slug]
    : null
  return {
    slug,
    mapping,
    imsStatus: mapping?.imsStatus ?? builtIn,
    source: mapping ? 'mapping' : (builtIn ? 'built-in' : 'unknown'),
    handledBy: slug === 'completed' ? 'completion-flow' : (slug === 'refunded' ? 'refund-sync' : null),
  }
}

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
