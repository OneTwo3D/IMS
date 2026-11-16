import { getXeroSettings } from './settings'
import { loadStoredXeroRateOf } from './tax-rate-lookup'
import { planXeroRoundingLine, unitDpLineGap, type XeroRoundingPlanInput, type XeroTaxRateOf } from './write-path'

export type UnitDpRoundingResolution = { ok: true; account: string | null; rateOf: XeroTaxRateOf | undefined } | { ok: false; error: string }

/**
 * Asked BEFORE any contact or item round trip: is there a unitdp=4 difference to post, and can the document be made to total what the order totals?
 * The plan (write-path.ts `planXeroRoundingLine`) is run here on the real tax rates and Rounding account, so a document that cannot be reconciled (no
 * Rounding account, a tax rate Xero's list does not carry, a difference rounding cannot explain) is refused with nothing created in Xero. The same plan
 * runs again in the builder with the `account` and `rateOf` returned. Settings and the tax-rate list are read only when the line amounts differ at all,
 * so a document whose prices Xero keeps exactly never touches them.
 */
export async function resolveUnitDpRoundingAccount(input: Omit<XeroRoundingPlanInput, 'account' | 'rateOf'>): Promise<UnitDpRoundingResolution> {
  if (unitDpLineGap(input.lines).isZero()) return { ok: true, account: null, rateOf: undefined }
  let rateOf: XeroTaxRateOf | undefined
  if (!input.lineAmountsIncludeTax) {
    const rates = await loadStoredXeroRateOf()
    if (!rates.ok) return { ok: false, error: `${input.what} cannot be posted: ${rates.error} Nothing was sent.` }
    rateOf = rates.rateOf
  }
  const account = (await getXeroSettings()).xero_rounding_difference_account?.trim() ?? ''
  try {
    planXeroRoundingLine({ ...input, account, rateOf })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, account: account || null, rateOf }
}
