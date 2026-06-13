// ---------------------------------------------------------------------------
// Production completion quantity resolution (audit-wght)
//
// Assembly completion previously always booked qtyProduced = qtyPlanned, adding
// output stock and spreading the run cost over the PLANNED quantity. With yield
// loss (fewer good units than planned) that over-states inventory quantity and
// under-states unit cost. The operator can now record the ACTUAL produced
// quantity at completion; component consumption stays at the planned BOM (the
// materials were still consumed), so the full run cost is capitalised into the
// fewer good units — a higher, correct unit cost.
// ---------------------------------------------------------------------------

/**
 * Resolve the output quantity for an ASSEMBLY completion. Defaults to the planned
 * quantity when no actual is supplied. The actual must be > 0 and cannot exceed
 * the planned quantity (materials were reserved/consumed for the planned run;
 * over-yield is out of scope here).
 */
export function resolveAssemblyOutputQty(params: {
  qtyPlanned: number
  actualQtyProduced?: number | null
}): { qty: number } | { error: string } {
  const { qtyPlanned, actualQtyProduced } = params
  if (actualQtyProduced == null) return { qty: qtyPlanned }
  if (!Number.isFinite(actualQtyProduced) || actualQtyProduced <= 0) {
    return { error: 'Actual produced quantity must be greater than 0.' }
  }
  if (actualQtyProduced > qtyPlanned) {
    return { error: `Actual produced quantity cannot exceed the planned quantity (${qtyPlanned}).` }
  }
  return { qty: actualQtyProduced }
}
