'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import { getTaxRates, updateTaxRate } from '@/app/actions/settings'
import { getShoppingTaxRateMappings, updateShoppingTaxRateMapping } from '@/app/actions/wc-sync'
import { fetchXeroTaxRates } from '@/app/actions/xero-sync'
import type { ImsRateLite, WcRateLite, XeroRateLite } from '@/lib/tax/tax-rate-match'

// ---------------------------------------------------------------------------
// audit-wrwr: data + persistence for the unified tax-rate mapper (onboarding
// wizard + Settings). The IMS TaxRate is the canonical hub; WooCommerce links via
// ShoppingTaxRateMapping, Xero links via TaxRate.accountingTaxType.
// ---------------------------------------------------------------------------

export type TaxRateMatchData = {
  imsRates: ImsRateLite[]
  wcRates: WcRateLite[]
  xeroRates: XeroRateLite[]
}

/**
 * Gather everything the matcher/UI needs in one round-trip. WC and Xero data are
 * only fetched when their connector is connected (the caller passes the flags it
 * already computed). Degrades to empty arrays so the UI hides absent columns.
 * Note: WC tax rates surface via ShoppingTaxRateMapping rows — run "Import from
 * store" (importWcTaxRatesFromApi) first to populate them.
 */
export async function getTaxRateMatchData(opts?: {
  includeWc?: boolean
  includeXero?: boolean
}): Promise<TaxRateMatchData> {
  await requirePermission('settings.company')
  const includeWc = opts?.includeWc ?? true
  const includeXero = opts?.includeXero ?? true

  const [imsRows, wcMappings, xeroRows] = await Promise.all([
    getTaxRates(false),
    includeWc ? getShoppingTaxRateMappings() : Promise.resolve([]),
    includeXero ? fetchXeroTaxRates() : Promise.resolve([]),
  ])

  return {
    imsRates: imsRows.map((r) => ({
      id: r.id,
      name: r.name,
      ratePct: r.rate * 100,
      accountingTaxType: r.accountingTaxType,
      active: r.active,
    })),
    wcRates: wcMappings.map((m) => ({
      externalTaxRateId: m.externalTaxRateId,
      externalName: m.externalName,
      externalRatePct: m.externalRatePct,
      taxRateId: m.taxRateId,
      mappingId: m.id,
    })),
    xeroRates: xeroRows.map((x) => ({ taxType: x.taxType, name: x.name, ratePct: x.rate })),
  }
}

/**
 * Apply confirmed cross-system links. Only writes rows the caller passes, so a
 * user's manual overrides are never clobbered by re-running auto-apply.
 * - wcLinks  → re-map a WC tax rate to an IMS rate (ShoppingTaxRateMapping).
 * - xeroLinks → set the IMS rate's accountingTaxType (queues the Xero push via
 *   updateTaxRate → maybeQueueTaxRateSync).
 */
export async function applyTaxRateMatches(input: {
  wcLinks?: Array<{ externalTaxRateId: string; taxRateId: string }>
  xeroLinks?: Array<{ taxRateId: string; accountingTaxType: string }>
}): Promise<{ success: boolean; wcLinked: number; xeroLinked: number; error?: string }> {
  await requirePermission('settings.company')
  try {
    let wcLinked = 0
    let xeroLinked = 0

    for (const link of input.wcLinks ?? []) {
      const res = await updateShoppingTaxRateMapping(link.externalTaxRateId, link.taxRateId)
      if (res.success) wcLinked++
    }
    for (const link of input.xeroLinks ?? []) {
      const res = await updateTaxRate(link.taxRateId, { accountingTaxType: link.accountingTaxType })
      if (res.success) xeroLinked++
    }

    if (wcLinked > 0 || xeroLinked > 0) {
      await logActivity({
        entityType: 'SETTING',
        tag: 'settings',
        action: 'tax_rate_mapping_applied',
        description: `Applied tax-rate matches: ${wcLinked} WooCommerce link(s), ${xeroLinked} Xero link(s)`,
        metadata: { wcLinked, xeroLinked },
      })
      revalidatePath('/sync')
      revalidatePath('/onboarding')
    }

    return { success: true, wcLinked, xeroLinked }
  } catch (e) {
    return { success: false, wcLinked: 0, xeroLinked: 0, error: String(e) }
  }
}
