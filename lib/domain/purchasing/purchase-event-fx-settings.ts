import { PURCHASE_EVENT_FX_SWITCH_KEY } from '@/lib/domain/settings/system-switches'

/**
 * PER-EVENT FX RATES FOR PURCHASING (o3d-hqvrp.51): the one reader of the master switch, for the code that will apply the policy.
 *
 * `purchase_event_fx_rates_enabled` is ON only for the exact string `true` (every boolean system switch reads that way); absent, or anything else, is off,
 * and off means no purchase valuation or posting changes. Read on the caller's client, so a transaction reads its own snapshot.
 *
 * Nothing calls this yet: the valuation that applies the policy is a later step.
 */
type SettingReadClient = { setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> } }

export async function isPurchaseEventFxEnabled(client: SettingReadClient): Promise<boolean> {
  const row = await client.setting.findUnique({ where: { key: PURCHASE_EVENT_FX_SWITCH_KEY }, select: { value: true } })
  return row?.value === 'true'
}
