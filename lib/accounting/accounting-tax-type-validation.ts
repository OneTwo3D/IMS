/**
 * Write-time validation for a mapped accounting TaxType (o3d-r30).
 *
 * The tax-rate mapper UI is populated from a possibly-cached display list, and a rate can be archived or
 * changed in Xero/QuickBooks between when it is shown and when the operator (or auto-apply) submits the
 * mapping. Persisting a no-longer-active TaxType into IMS.TaxRate.accountingTaxType would break later
 * invoice/bill sync. So the WRITE boundary re-checks the selected TaxType against a LIVE fetch of the
 * active connector's tax rates before persisting.
 */

/**
 * True when `taxType` is CONFIRMED absent from the live active-connector rate set — i.e. we have a
 * non-empty live list to judge against and the TaxType is not in it. Fails OPEN (returns false) when the
 * live list is empty: the connector may be temporarily unreachable, and blocking all mapping writes on a
 * transient outage is worse than allowing one the drift sweeper will later flag.
 */
export function isUnknownActiveTaxType(
  taxType: string,
  liveRates: ReadonlyArray<{ taxType: string }>,
): boolean {
  if (liveRates.length === 0) return false
  return !liveRates.some((rate) => rate.taxType === taxType)
}
