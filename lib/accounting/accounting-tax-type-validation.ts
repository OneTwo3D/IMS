/**
 * Write-time validation for a mapped accounting TaxType (o3d-r30).
 *
 * The tax-rate mapper UI is populated from a possibly-cached display list, and a rate can be archived or
 * changed in Xero between when it is shown and when the operator (or auto-apply) submits the mapping.
 * Persisting a no-longer-active TaxType into IMS.TaxRate.accountingTaxType would break later invoice/bill
 * sync. So every caller-controlled accountingTaxType write (create + update) re-checks the selected
 * TaxType against a LIVE fetch of Xero's tax rates before persisting.
 *
 * This is scoped to Xero: it is the connector whose reference reads are cached (QuickBooks tax codes are
 * not cached), so it is the only connector where a stale display can drive a bad write.
 */

export type TaxTypeValidation = { ok: true } | { ok: false; error: string }

/**
 * Pure classifier. `live` is the result of a LIVE getXeroTaxRates() call:
 *   - null  => the fetch FAILED (connector unreachable). We cannot confirm the TaxType, so fail CLOSED —
 *              a genuine archival and a transient outage look the same, and persisting an unvalidated
 *              type is exactly the integrity risk this guard exists to prevent.
 *   - {taxRates} => authoritative. A TaxType absent from it (including an all-archived empty set) is
 *              rejected; a present one is accepted.
 */
export function classifyXeroTaxType(
  taxType: string,
  live: { taxRates: ReadonlyArray<{ taxType: string }> } | null,
): TaxTypeValidation {
  if (!live) {
    return {
      ok: false,
      error: `Cannot validate tax type "${taxType}" — Xero is currently unreachable. Try again once the connection is restored.`,
    }
  }
  if (!live.taxRates.some((rate) => rate.taxType === taxType)) {
    return {
      ok: false,
      error: `Tax type "${taxType}" is not a currently-active Xero tax rate — refresh the tax-rate list and re-map.`,
    }
  }
  return { ok: true }
}

/**
 * Validate a caller-supplied accountingTaxType before persisting it. Fetches Xero's rates LIVE (never
 * the reference cache). A no-op { ok: true } when the active connector is not Xero (QuickBooks codes are
 * not cached, so no stale-display risk) or when there is no active connector.
 */
export async function validateAccountingTaxTypeForWrite(taxType: string): Promise<TaxTypeValidation> {
  const { getActiveAccountingConnectorInfo } = await import('@/lib/accounting')
  const active = await getActiveAccountingConnectorInfo()
  if (active?.id !== 'xero') return { ok: true }
  const { getXeroTaxRates } = await import('@/lib/connectors/xero/accounts')
  const live = await getXeroTaxRates() // LIVE — no allowCache
  return classifyXeroTaxType(taxType, live)
}
