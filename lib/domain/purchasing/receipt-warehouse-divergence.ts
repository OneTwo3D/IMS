// ---------------------------------------------------------------------------
// Receipt warehouse divergence (audit-H7)
//
// Per-line warehouse choice at receive time is a feature, but receiving a line
// into a warehouse other than the PO's planned destination silently sends stock
// (and its cost layers) to the wrong site — and landed-cost distribution assumed
// the planned location. This flags lines whose chosen warehouse differs from the
// PO destination so the UI can warn + require confirmation and the receipt log
// can record it. Pure function over plain inputs.
// ---------------------------------------------------------------------------

export type ReceiptWarehouseDivergence = {
  poLineId: string
  receivedWarehouseId: string
  destinationWarehouseId: string
}

/**
 * Lines whose receive warehouse differs from the PO's destination warehouse.
 * Returns [] when the PO has no destination set (nothing to diverge from) or
 * when every line matches.
 */
export function findDivergentReceiptLines(params: {
  destinationWarehouseId: string | null | undefined
  lines: Array<{ poLineId: string; warehouseId: string }>
}): ReceiptWarehouseDivergence[] {
  const destination = params.destinationWarehouseId
  if (!destination) return []
  return params.lines
    .filter((line) => line.warehouseId && line.warehouseId !== destination)
    .map((line) => ({
      poLineId: line.poLineId,
      receivedWarehouseId: line.warehouseId,
      destinationWarehouseId: destination,
    }))
}
