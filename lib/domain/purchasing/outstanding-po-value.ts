// o3d-1di / o3d-27l.
//
// This lives OUTSIDE app/actions/dashboard.ts because that file carries 'use server', and a
// 'use server' module may only export ASYNC functions — a synchronous export there compiles under
// `tsc` but fails `next build`, which is how it reached CI unnoticed. It is a pure function with no
// database access, so it belongs in the domain layer regardless.

/**
 * Outstanding (not-yet-received) NET GOODS value of open purchase orders, in base currency (o3d-1di).
 *
 * Basis: the persisted `subtotalBase` — the net-of-VAT goods subtotal AFTER the order-level (header)
 * discount (purchase-orders.ts reduces subtotalBase by the net-base header discount at creation) —
 * scaled by the value-weighted outstanding fraction, Σ(remaining × unitCostBase) ÷ Σ(qty ×
 * unitCostBase). Deriving the money from stored net bases avoids reconstructing the raw header
 * discountAmount (which is foreign, and gross when prices include VAT) with its FX direction and VAT
 * convention. Goods only: VAT (recoverable) and freight (tracked separately as landed cost) are
 * excluded — this is the committed goods spend still to arrive, so a mostly-received PO contributes
 * only what is still on the way, not its whole total. Exported for unit testing; the caller passes the
 * INCOMING_PO_STATUSES POs.
 *
 * Invariant: subtotalBase is the post-header-discount net goods value. A separate pre-existing bug
 * (o3d-lx1) lets submitSupplierQuote overwrite subtotalBase without reapplying the header discount;
 * that corrupts the PO's own totals for every consumer and is tracked/fixed there, not papered over
 * here.
 */
export function outstandingPoValueBase(
  pos: {
    subtotalBase?: unknown
    lines: { qty: unknown; qtyReceived: unknown; unitCostBase: unknown }[]
  }[],
): number {
  let total = 0
  for (const po of pos) {
    let grossGoods = 0
    let outstandingGoods = 0
    for (const l of po.lines) {
      const qty = Number(l.qty)
      const lineCost = Number(l.unitCostBase)
      grossGoods += qty * lineCost
      outstandingGoods += Math.max(0, qty - Number(l.qtyReceived)) * lineCost
    }
    if (grossGoods <= 0 || outstandingGoods <= 0) continue
    // Net goods after the header discount is the stored subtotalBase; fall back to the line gross when
    // it is absent (no header discount to apply). Scale by the outstanding fraction of goods value.
    const netGoodsBase = Number(po.subtotalBase ?? grossGoods)
    total += netGoodsBase * (outstandingGoods / grossGoods)
  }
  return total
}
