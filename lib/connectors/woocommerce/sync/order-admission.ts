/**
 * WHICH ORDERS MAY IMS TAKE ON? — the settings half of the `wc_sync_order_statuses`
 * admission boundary (o3d-tj6v r4).
 *
 * The RULE is pure and lives in `../order-status-filter` (`isWcOrderAdmittedByStatus`). This
 * module is only the settings read, hoisted out of `webhooks.ts` for two reasons:
 *
 *   1. THE WEBHOOK IS NOT THE ONLY WAY AN UNHELD ORDER GETS CREATED. `sweepWithdrawalSuppressions`
 *      re-reads a previously-withdrawn order BY ID — no status query, no cursor — and puts it
 *      straight through `importWcOrder`. Round 3 gated the webhook and left that path open, so an
 *      order in a status the operator excluded still entered IMS through the withdrawal recovery.
 *      One resolver, used by both, is what stops a third ingress being missed next time.
 *
 *   2. IT DELIBERATELY DOES NOT ASK WHETHER IMS ALREADY HOLDS THE ORDER. That question has exactly
 *      one authority — the `findFirst` inside `importWcOrder` that decides create-vs-update — and
 *      asking it a second time here is what made the pivot raceable (see `admitCreate` in
 *      order-import.ts).
 */

import { db } from '@/lib/db'
import {
  isWcOrderAdmittedByStatus,
  parseWcSyncOrderStatuses,
  WC_SYNC_ORDER_STATUSES_SETTING_KEY,
} from '../order-status-filter'
import type { WcFullOrder } from './types'

export type WcOrderCreateAdmission = {
  /** May an order IMS has NEVER SEEN be created from this payload? */
  admitted: boolean
  /** The operator's current selection, for the operator-facing message. */
  configured: string[]
}

/**
 * Read the selection and judge this payload's CURRENT status against it.
 *
 * Settings only: no link lookup, no order lookup, nothing that could go stale between here and
 * the create it governs.
 */
export async function resolveWcOrderCreateAdmission(
  wcOrder: Pick<WcFullOrder, 'status'>,
): Promise<WcOrderCreateAdmission> {
  const { getWithdrawalStatuses } = await import('./withdrawal')
  const [setting, withdrawal] = await Promise.all([
    db.setting.findUnique({ where: { key: WC_SYNC_ORDER_STATUSES_SETTING_KEY } }),
    getWithdrawalStatuses(),
  ])
  const configured = parseWcSyncOrderStatuses(setting?.value)
  return {
    admitted: isWcOrderAdmittedByStatus(wcOrder.status, configured, withdrawal),
    configured,
  }
}
