/**
 * Detect multi-component IMS TaxRates used on invoice/bill lines.
 *
 * Per-line TaxType split for a multi-component TaxRate (e.g. GST 5% + PST 7%
 * compound) double-counts the goods value or distorts the per-component tax
 * base — see PR #184 for the analysis. The correct integration shape is to
 * configure the equivalent TaxRate with TaxComponents on the accounting side
 * (Xero TaxRates API), so IMS sends one parent accountingTaxType and the
 * accounting system handles the breakdown.
 *
 * Until the IMS→Xero TaxRate sync helper (onetwo3d-ims-t6r) lands, the only
 * defense is a WARNING activity log telling the operator to configure the
 * components on the accounting side. This helper produces the set of affected
 * rate names so the action layer can emit a single tagged warning.
 */

export type TaxRateSnapshotForWarning = {
  name: string | null
  isCompound: boolean
  components: Array<{ id: string }>
} | null

export type LineWithTaxRateSnapshot = {
  taxRate: TaxRateSnapshotForWarning
}

export function multiComponentTaxRateNames(lines: LineWithTaxRateSnapshot[]): string[] {
  const names = new Set<string>()
  for (const line of lines) {
    if (!line.taxRate) continue
    const { isCompound, components, name } = line.taxRate
    if (!name) continue
    if (isCompound || components.length > 0) names.add(name)
  }
  return [...names].sort()
}
