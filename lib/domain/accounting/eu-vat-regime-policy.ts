/**
 * THE REGIME POLICY: the settings an EU VAT regime decision was made under (the regime mode, the gift-card flag cut-in, the IOSS, DDP, fee and rounding accounts, and the base currency the threshold is converted to), as a comparable record.
 *
 * A treated invoice records the policy of the ONE settings read its decision used (the treatment, lib/connectors/woocommerce/sync/eu-vat-invoice-treatment.ts). Everything that releases or posts it later compares that record with the policy in force NOW and refuses a difference:
 *   - the held-invoice sweep, which has no order to re-verify with;
 *   - the Xero poster, immediately before a treated payload is sent, because a queued payload can wait and a setting can change meanwhile.
 * A treated payload with no recorded policy is refused too: nothing is guessed.
 */
import { EU_VAT_GIFT_CARD_CUT_IN_SETTING, EU_VAT_REGIME_MODE_SETTING, parseGiftCardCutIn, parseRegimeMode, type GiftCardCutIn } from '@/lib/domain/accounting/eu-vat-settings'
import { getSettingValues } from '@/lib/settings-store'

export type RegimePolicy = Record<string, string>

/** The settings the treatment reads (checked: eu-vat-facts.ts reads the regime mode and the cut-in and takes the base currency as an option; the treatment takes the IOSS, DDP, fee and rounding accounts from the accounting settings; the posted tax types are bound separately by the tax binding and the fresh build). */
export function regimePolicyOf(parts: { mode: string | null; cutIn: GiftCardCutIn; ioss: string | null; ddp: string | null; fee: string | null; rounding: string | null; baseCurrency: string | null }): RegimePolicy {
  const { cutIn } = parts
  return {
    mode: parts.mode ?? 'unreadable',
    cutIn: cutIn.state === 'ok' ? cutIn.at.toISOString() : cutIn.state === 'unset' ? 'unset' : `invalid:${cutIn.raw}`,
    ioss: String(parts.ioss ?? ''),
    ddp: String(parts.ddp ?? ''),
    fee: String(parts.fee ?? ''),
    rounding: String(parts.rounding ?? ''),
    baseCurrency: parts.baseCurrency ?? 'unreadable',
  }
}

/** The policy fields that are ACCOUNTS: changing one changes the posted accounts and, for IOSS and DDP, the regime stamp's account, which is write-once, so a re-import cannot adopt it. */
export const REGIME_POLICY_ACCOUNT_KEYS = ['ioss', 'ddp', 'fee', 'rounding'] as const

/** The policy in force now: the settings are read here and nowhere else on the compare side. An unreadable setting is an unreadable policy, which never equals a recorded one. */
export async function currentRegimePolicy(): Promise<RegimePolicy> {
  const { getAccountingSettings } = await import('@/lib/accounting')
  const { getBaseCurrencyCode } = await import('@/lib/base-currency')
  const [values, settings, baseCurrency] = await Promise.all([
    getSettingValues([EU_VAT_REGIME_MODE_SETTING, EU_VAT_GIFT_CARD_CUT_IN_SETTING]).catch(() => null),
    getAccountingSettings(),
    getBaseCurrencyCode().catch(() => null),
  ])
  const mode = values === null ? null : parseRegimeMode(values.get(EU_VAT_REGIME_MODE_SETTING))
  const cutIn: GiftCardCutIn = values === null ? { state: 'invalid', raw: 'setting could not be read' } : parseGiftCardCutIn(values.get(EU_VAT_GIFT_CARD_CUT_IN_SETTING))
  return regimePolicyOf({ mode, cutIn, ioss: settings.euVatIossAccount ?? null, ddp: settings.euVatDdpAccount ?? null, fee: settings.euFeeAccount ?? null, rounding: settings.roundingDifferenceAccount ?? null, baseCurrency })
}

export type RegimePolicyDifference = { problem: string; /** Recorded account fields whose value changed. Not set for a hold that merely lacks a field (parked before it was recorded). */ accountsChanged: string[] }

/** Null when the recorded policy equals the one in force. A field the record lacks is a mismatch (fail closed) but is not counted as a CHANGED account. */
export async function regimePolicyDifference(recorded: unknown): Promise<RegimePolicyDifference | null> {
  if (typeof recorded !== 'object' || recorded === null) return { problem: 'it was prepared before the regime settings it was decided under were recorded', accountsChanged: [] }
  const now = await currentRegimePolicy()
  const was = recorded as Record<string, unknown>
  const differing = Object.keys(now).filter((key) => was[key] !== now[key])
  if (differing.length === 0) return null
  const accountsChanged = differing.filter((key) => (REGIME_POLICY_ACCOUNT_KEYS as readonly string[]).includes(key) && was[key] !== undefined)
  return { problem: `the EU VAT regime settings changed since it was prepared (${differing.join(', ')})`, accountsChanged }
}

/** Null when the recorded policy equals the one in force; otherwise why the payload must not be released or posted. */
export async function regimePolicyProblem(recorded: unknown): Promise<string | null> {
  return (await regimePolicyDifference(recorded))?.problem ?? null
}
