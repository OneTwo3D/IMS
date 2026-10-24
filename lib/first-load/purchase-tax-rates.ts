/**
 * THE ONE RESOLUTION OF A SUPPLIER'S PURCHASE TAX TYPE TO IMS TAX RATES. The supplier importer (which sets Supplier.taxRateId), the `tax-rates` rail (which refuses a run that
 * cannot resolve) and the read-back (which decides whether a stored supplier already matches the file) all ask this one question, so they cannot disagree:
 * the rates that are ACTIVE, usable for purchases (usedFor PURCHASE or BOTH) and carry that accountingTaxType. Exactly one is a resolution; none or several is not.
 */
export interface PurchaseRateReader {
  taxRate: { findMany(args: { where: { active: true; usedFor: { in: string[] }; accountingTaxType: { not: null } }; select: { id: true; accountingTaxType: true } }): Promise<Array<{ id: string; accountingTaxType: string | null }>> }
}

/** Xero tax type -> the ids of every eligible rate carrying it. */
export async function loadPurchaseRatesByType(client: PurchaseRateReader): Promise<Map<string, string[]>> {
  const byType = new Map<string, string[]>()
  for (const rate of await client.taxRate.findMany({
    where: { active: true, usedFor: { in: ['PURCHASE', 'BOTH'] }, accountingTaxType: { not: null } },
    select: { id: true, accountingTaxType: true },
  })) byType.set(rate.accountingTaxType!, [...(byType.get(rate.accountingTaxType!) ?? []), rate.id])
  return byType
}

/** The id of the one eligible rate for a type, or null when there is none or several. */
export function uniqueRateId(byType: ReadonlyMap<string, readonly string[]>, taxType: string): string | null {
  const ids = byType.get(taxType) ?? []
  return ids.length === 1 ? ids[0]! : null
}
