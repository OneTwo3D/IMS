import type { Prisma } from '@/app/generated/prisma/client'

/**
 * THE TURN-ON INTERLOCK OF `stock_adjustment_reason_cost_required` (the settings command runs it in the dry run and again inside the write transaction).
 *
 * With the switch ON every stock adjustment must name an ACTIVE adjustment reason, and (when the accounting connector would post the adjustment's journal) that reason must
 * carry an account (lib/domain/inventory/stock-adjustment-policy.ts: unmappedReasonMessage). Turning it on with no active reason, or, while Xero sync is on, with no active
 * reason that has an account, would refuse every adjustment from the first minute, so it is refused here instead. The inventory account is a settings row and is checked by
 * the registry's `requiresMappedSettings`.
 */
export async function stockAdjustmentSwitchOnRefusal(client: Pick<Prisma.TransactionClient, 'setting' | 'adjustmentReason'>): Promise<string | null> {
  const active = await client.adjustmentReason.findMany({ where: { active: true }, select: { name: true, accountCode: true } })
  if (active.length === 0) {
    return 'stock_adjustment_reason_cost_required cannot be turned on: no active adjustment reason exists, so every stock adjustment would be refused. Create at least one active reason (Settings > Inventory > Adjustment Reasons), with a GL account, first.'
  }
  const sync = await client.setting.findUnique({ where: { key: 'xero_sync_enabled' }, select: { value: true } })
  if (sync?.value === 'true' && !active.some((r) => (r.accountCode ?? '').trim() !== '')) {
    return 'stock_adjustment_reason_cost_required cannot be turned on while Xero sync is on and no active adjustment reason has an account: every valued adjustment would be refused. Give at least one active reason a GL account (Settings > Inventory > Adjustment Reasons) first.'
  }
  return null
}
