/**
 * THE REGIME POLICY: the settings an EU VAT regime decision was made under (the regime mode, the gift-card flag cut-in, the IOSS and DDP accounts), as a comparable record.
 *
 * A treated invoice records the policy of the ONE settings read its decision used (the treatment, lib/connectors/woocommerce/sync/eu-vat-invoice-treatment.ts). Everything that releases or posts it later compares that record with the policy in force NOW and refuses a difference:
 *   - the held-invoice sweep, which has no order to re-verify with;
 *   - the Xero poster, immediately before a treated payload is sent, because a queued payload can wait and a setting can change meanwhile.
 * A treated payload with no recorded policy is refused too: nothing is guessed.
 */
import { EU_VAT_GIFT_CARD_CUT_IN_SETTING, EU_VAT_REGIME_MODE_SETTING, parseGiftCardCutIn, parseRegimeMode, type GiftCardCutIn } from '@/lib/domain/accounting/eu-vat-settings'
import { getSettingValues } from '@/lib/settings-store'

export type RegimePolicy = Record<string, string>

export function regimePolicyOf(mode: string | null, cutIn: GiftCardCutIn, ioss: string | null, ddp: string | null): RegimePolicy {
  return {
    mode: mode ?? 'unreadable',
    cutIn: cutIn.state === 'ok' ? cutIn.at.toISOString() : cutIn.state === 'unset' ? 'unset' : `invalid:${cutIn.raw}`,
    ioss: String(ioss ?? ''),
    ddp: String(ddp ?? ''),
  }
}

/** The policy in force now: the settings are read here and nowhere else on the compare side. An unreadable setting is an unreadable policy, which never equals a recorded one. */
export async function currentRegimePolicy(): Promise<RegimePolicy> {
  const { getAccountingSettings } = await import('@/lib/accounting')
  const [values, settings] = await Promise.all([
    getSettingValues([EU_VAT_REGIME_MODE_SETTING, EU_VAT_GIFT_CARD_CUT_IN_SETTING]).catch(() => null),
    getAccountingSettings(),
  ])
  const mode = values === null ? null : parseRegimeMode(values.get(EU_VAT_REGIME_MODE_SETTING))
  const cutIn: GiftCardCutIn = values === null ? { state: 'invalid', raw: 'setting could not be read' } : parseGiftCardCutIn(values.get(EU_VAT_GIFT_CARD_CUT_IN_SETTING))
  return regimePolicyOf(mode, cutIn, settings.euVatIossAccount ?? null, settings.euVatDdpAccount ?? null)
}

/** Null when the recorded policy equals the one in force; otherwise why the payload must not be released or posted. */
export async function regimePolicyProblem(recorded: unknown): Promise<string | null> {
  if (typeof recorded !== 'object' || recorded === null) return 'it was prepared before the regime settings it was decided under were recorded'
  const now = await currentRegimePolicy()
  const was = recorded as Record<string, unknown>
  const differing = Object.keys(now).filter((key) => was[key] !== now[key])
  return differing.length === 0 ? null : `the EU VAT regime settings changed since it was prepared (${differing.join(', ')})`
}
