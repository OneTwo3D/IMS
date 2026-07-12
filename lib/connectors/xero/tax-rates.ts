/**
 * Push IMS TaxRate definitions (with TaxComponents) to Xero.
 *
 * Multi-component IMS TaxRates can't be expressed as multiple per-line TaxTypes
 * on the invoice payload without distorting the goods total or per-component
 * tax base (see PR #184). Instead, the IMS TaxRate is mirrored to a Xero
 * TaxRate whose TaxComponents define the breakdown. Then per-invoice IMS
 * sends one parent accountingTaxType for that rate, and Xero handles the
 * component-level VAT-return reporting.
 *
 * This module wraps Xero's POST /TaxRates endpoint. Xero matches by Name, so
 * the call is idempotent for the same Name + Status — re-running an unchanged
 * sync is safe.
 */

import { xeroGet, xeroPost } from './api'

export type XeroTaxComponent = {
  Name: string
  Rate: number
  IsCompound?: boolean
  IsNonRecoverable?: boolean
}

export type XeroTaxRate = {
  Name: string
  ReportTaxType?: string
  TaxComponents: XeroTaxComponent[]
  Status?: 'ACTIVE' | 'DELETED' | 'ARCHIVED'
}

export type ImsTaxRateComponentForXero = {
  name: string
  rate: number
  compoundOnPrevious: boolean
  /** Currently unused on Xero's side (the parent ReportTaxType maps to the IMS
   *  rate's accountingTaxType); reserved for future per-component reporting. */
  accountingTaxType?: string | null
}

/**
 * Build the Xero TaxRate payload from an IMS TaxRate + active components.
 *
 * Xero rates are percent (e.g. 5 for 5%); IMS stores them as decimals (e.g.
 * 0.05). Convert here so the helper accepts IMS-shaped input.
 */
export function buildXeroTaxRatePayload(input: {
  name: string
  reportTaxType?: string | null
  components: ImsTaxRateComponentForXero[]
  status?: 'ACTIVE' | 'ARCHIVED'
}): XeroTaxRate {
  return {
    Name: input.name,
    ReportTaxType: input.reportTaxType ?? undefined,
    TaxComponents: input.components.map((component) => ({
      Name: component.name,
      // IMS rates are decimals (0.05) — Xero expects percent (5).
      Rate: Math.round(component.rate * 100 * 10000) / 10000,
      IsCompound: component.compoundOnPrevious ? true : undefined,
    })),
    Status: input.status ?? 'ACTIVE',
  }
}

export async function putXeroTaxRate(
  input: {
    name: string
    reportTaxType?: string | null
    components: ImsTaxRateComponentForXero[]
    status?: 'ACTIVE' | 'ARCHIVED'
  },
  opts?: { idempotencyKey?: string },
): Promise<{ success: boolean; taxType?: string; error?: string }> {
  const payload = { TaxRates: [buildXeroTaxRatePayload(input)] }
  const res = await xeroPost<{ TaxRates: Array<{ TaxType: string; Name: string }> }>(
    'TaxRates',
    payload,
    opts,
  )
  if (!res.ok || !res.data?.TaxRates?.length) {
    return { success: false, error: res.error ?? 'Failed to push tax rate' }
  }
  return { success: true, taxType: res.data.TaxRates[0].TaxType }
}

/**
 * Fetch the live Xero TaxRates (with their TaxComponents) for drift detection.
 * Excludes DELETED/ARCHIVED rates so a deleted Xero rate reads as missing-on-xero
 * rather than a phantom match. Throws on an API failure so the sweeper can record
 * the run as errored rather than silently report "no drift".
 */
export async function fetchXeroTaxRates(): Promise<XeroTaxRate[]> {
  const res = await xeroGet<{ TaxRates?: XeroTaxRate[] }>('TaxRates')
  if (!res.ok || !res.data) {
    throw new Error(res.error ?? `Failed to fetch Xero tax rates (status ${res.status})`)
  }
  return (res.data.TaxRates ?? []).filter((rate) => rate.Status !== 'DELETED' && rate.Status !== 'ARCHIVED')
}
