export function assertFinitePurchaseReceiptUnitCost(unitCostBase: number): void {
  if (!Number.isFinite(unitCostBase) || unitCostBase < 0) {
    throw new Error('Purchase receipt unitCostBase must be finite and zero or greater')
  }
}
