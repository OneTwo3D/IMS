import { PURCHASE_EVENT_FX_STEPS_COMPLETE, PURCHASE_EVENT_FX_SWITCH_KEY } from '@/lib/domain/settings/system-switches'

/**
 * PER-EVENT FX RATES FOR PURCHASING (o3d-hqvrp.51): the one reader of the master switch, for the code that will apply the policy.
 *
 * `purchase_event_fx_rates_enabled` is ON only for the exact string `true` (every boolean system switch reads that way); absent, or anything else, is off,
 * and off means no purchase valuation or posting changes. Read on the caller's client, so a transaction reads its own snapshot.
 *
 * Read by the receipt valuation (lib/domain/purchasing/purchase-receipt-fx.ts, step 2), the bill (lib/domain/purchasing/purchase-bill-fx.ts, step 3)
 * and the order page's prepayment panel.
 *
 * THE INTERLOCK, ON READ TOO: while `PURCHASE_EVENT_FX_STEPS_COMPLETE` is false the switch reads OFF whatever is stored, so a value written around the
 * turn-on refusal (a database edit, a restore) cannot put a half-installed policy into effect.
 */
type SettingReadClient = { setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> } }

let stepsCompleteOverrideForTests: boolean | null = null

/** TESTS ONLY: force the interlock (true: installed; false: a build before the last step, so the switch reads off). `null` restores the real interlock. */
export function setPurchaseEventFxStepsCompleteForTests(value: boolean | null): void {
  stepsCompleteOverrideForTests = value
}

export async function isPurchaseEventFxEnabled(client: SettingReadClient): Promise<boolean> {
  if (!(stepsCompleteOverrideForTests ?? PURCHASE_EVENT_FX_STEPS_COMPLETE)) return false
  const row = await client.setting.findUnique({ where: { key: PURCHASE_EVENT_FX_SWITCH_KEY }, select: { value: true } })
  return row?.value === 'true'
}
