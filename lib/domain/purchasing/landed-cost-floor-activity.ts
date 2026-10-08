import { logActivity } from '@/lib/activity-log'
import { describeFlooredLandedCredit, totalUnabsorbedBase, type FlooredLandedCreditEntry } from './landed-cost-floor-text'

/** The activity `action` of the durable WARNING; one name so a reader can find every surface's entry. */
export const LANDED_COST_CREDIT_FLOORED_ACTION = 'landed_cost_credit_floored'

/**
 * Write the durable activity WARNING for a floored negative landed cost. It uses its own connection, so a
 * caller inside a transaction must call it AFTER the commit (the entry would otherwise outlive a rollback);
 * `logActivity` never throws, so a failure here cannot undo a committed receipt or revaluation.
 */
export async function logFlooredLandedCredit(params: {
  purchaseOrderId: string | null
  context: string
  entries: FlooredLandedCreditEntry[]
}): Promise<string> {
  const description = describeFlooredLandedCredit({ context: params.context, entries: params.entries })
  await logActivity({
    entityType: 'PURCHASE_ORDER',
    entityId: params.purchaseOrderId,
    action: LANDED_COST_CREDIT_FLOORED_ACTION,
    tag: 'purchase',
    level: 'WARNING',
    description,
    metadata: {
      context: params.context,
      unabsorbedBase: totalUnabsorbedBase(params.entries).toFixed(2),
      lines: params.entries.map((entry) => ({
        label: entry.label,
        unabsorbedBase: entry.unabsorbedBase.toFixed(2),
        unflooredGrossUnitCostBase: entry.unflooredGrossUnitCostBase.toFixed(6),
      })),
    },
    resolveUser: false,
  })
  return description
}
