import { type StockMovementType } from '@/app/generated/prisma/client'
import {
  multiplyMoney,
  roundQuantity,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'

export type StockMovementValueFields = {
  unitCostBase: string
  totalValueBase: string
}

// Sentinel for historical demand imports where source FIFO/cost provenance is unavailable.
export const HISTORICAL_IMPORT_UNIT_COST = 0

// referenceTypes used by the forecasting-only sales-history imports (WooCommerce
// historical/initial + CSV). Their SALE_DISPATCH movements are zero-cost demand
// records with no warehouse and no COGS evidence, excluded from stock/stats/COGS/
// retention — and from the outbound COGS-evidence guard (DB trigger + invariants).
export const HISTORICAL_IMPORT_REFERENCE_TYPES = ['WcHistorical', 'WcInitialImport', 'CsvHistorical'] as const

export const STOCK_MOVEMENT_VALUE_SOURCE_BY_TYPE: Record<StockMovementType, string> = {
  ADJUSTMENT: 'positive adjustments use average/historical cost; negative adjustments use FIFO consumption',
  KIT_ASSEMBLY_IN: 'reserved legacy type; active manufacturing assembly writes PRODUCTION_IN',
  KIT_ASSEMBLY_OUT: 'reserved legacy type; active manufacturing assembly writes PRODUCTION_OUT',
  OPENING_STOCK: 'opening stock uses the explicit opening unit cost',
  PRODUCTION_IN: 'manufacturing output/recovery uses consumed component and overhead cost',
  PRODUCTION_OUT: 'manufacturing consumption/disassembly uses FIFO consumption',
  PURCHASE_RECEIPT: 'purchase receipts use landed or gross purchase unit cost',
  PURCHASE_REVERSAL: 'purchase cancellation reversals use the remaining PO receipt cost-layer cost',
  RETURN_INBOUND: 'customer returns use shipped cost snapshots where available',
  SALE_DISPATCH: 'sales dispatch uses FIFO consumption, historical imports use zero-cost provenance sentinel',
  TRANSFER_IN: 'transfer receipts use the dispatch FIFO snapshot slice',
  TRANSFER_OUT: 'transfer dispatch uses FIFO consumption',
  WMS_RECEIPT_RECONCILIATION: 'WMS reconciliation uses source PO/transfer cost or zero-value audit markers',
}

type ConsumedLayerValue = {
  qty: Decimal
  unitCostBase: Decimal
}

function roundMovementValue(value: DecimalInput): Decimal {
  return roundQuantity(value, 6)
}

function decimalField(value: DecimalInput): string {
  return roundMovementValue(value).toFixed(6)
}

export function buildStockMovementValueFields(params: {
  qty: DecimalInput
  unitCostBase: DecimalInput
}): StockMovementValueFields {
  const qty = toDecimal(params.qty).abs()
  const unitCostBase = roundMovementValue(params.unitCostBase)
  if (unitCostBase.lt(0)) {
    throw new Error('Stock movement unit cost must be zero or greater')
  }
  const totalValueBase = roundMovementValue(multiplyMoney(qty, unitCostBase))

  return {
    unitCostBase: decimalField(unitCostBase),
    totalValueBase: decimalField(totalValueBase),
  }
}

/**
 * REFUSES A NEGATIVE IMPLIED UNIT COST rather than absolutising it (o3d-gd2f).
 *
 * A movement's `qty` is a MAGNITUDE — direction lives in `fromWarehouseId` /
 * `toWarehouseId`, and a negative stored qty is itself a CRITICAL inventory-invariant
 * finding (`stock_movement_negative_quantity`, lib/domain/inventory/invariants.ts:824).
 * So `qty` is absolutised here, as it always was, and a caller may still express an
 * outbound movement as the CONSISTENT pair (negative qty, negative total): the implied
 * unit cost is then positive and the result is unchanged.
 *
 * What used to happen, and was wrong, is the INCONSISTENT pair — a positive qty with a
 * negative total, i.e. a genuinely negative basis. `.abs()` on the total silently
 * discarded that sign, so a −£4 layer booked a +£4 movement that looked entirely
 * ordinary, while the `cogs_entries` rows written for the SAME consumption kept the
 * negative sign (`cogsEntryDataFromConsumed`, lib/cost-layers.ts:280-281). The movement
 * ledger and the COGS subledger disagreed in sign, silently.
 *
 * The sibling `buildStockMovementValueFields` above has always REFUSED a negative unit
 * cost outright. This form now enforces the same invariant instead of hiding a
 * violation of it: it is the same refusal the transfer-receipt re-layering helper makes
 * (`NegativeCostSnapshotEntryError` in lib/domain/inventory/transfer-cost-layer-recreation.ts).
 *
 * THIS FUNCTION IS NOT A CHOKE POINT for every costed movement, and must not be described
 * as one. It is one of TWO builders. The sibling above is called directly by THIRTEEN
 * production writers that never reach this one — opening stock, purchase receipt, PO
 * cancellation reversal, customer-return inbound, the positive half of a stock adjustment,
 * the adjustment-edit addition branch, the WooCommerce and CSV historical imports, the
 * Mintsoft allocation sync, and three WMS booked-in paths. Negative-basis cover comes from
 * BOTH builders refusing (25 production call sites between them), not from this one being a
 * funnel. The TWELVE call sites that do reach here — five direct, seven via
 * `buildStockMovementValueFieldsFromConsumed` — are the FIFO-consumption and
 * snapshot-valued paths the transfer helper never covered: sales dispatch, TRANSFER_OUT,
 * TRANSFER_IN, supplier return, manufacturing consumption and recovery, stock-adjustment
 * removal and adjustment edit. Those now fail loudly rather than mis-state. The exact
 * per-file census is ASSERTED (not merely asserted to exist) by the call-site census test
 * in tests/domain/inventory/stock-movement-value.test.ts, so adding, moving or removing a
 * call site anywhere under app/ or lib/ fails that test until the census is updated.
 *
 * THIS IS NOT NEGATIVE-BASIS SUPPORT and deliberately does not decide what one should
 * mean. Representing a credit-derived basis end to end (signed movement values, a
 * credit COGS journal pair in both connectors) is o3d-gd2f / docs/todo/
 * negative-basis-cost-layers-decision.md, and is not authorised. Until it is, the
 * correct outcome for a negative basis is a visible failure where an operator can act
 * on the credit cost line that caused it.
 */
export function buildStockMovementValueFieldsFromTotal(params: {
  qty: DecimalInput
  totalValueBase: DecimalInput
}): StockMovementValueFields {
  const signedQty = toDecimal(params.qty)
  const signedTotal = roundMovementValue(params.totalValueBase)
  const qty = signedQty.abs()
  const requestedTotal = signedTotal.abs()
  if (qty.isZero() && !requestedTotal.isZero()) {
    throw new Error('Stock movement total value requires a non-zero quantity')
  }
  // Derived from the SIGNED operands, so the sign the caller established survives long
  // enough to be judged. Both-negative (an outbound pair) divides to a positive cost and
  // passes; a sign disagreement is a negative basis and is refused.
  if (qty.gt(0) && signedTotal.div(signedQty).lt(0)) {
    throw new Error(
      'Stock movement unit cost must be zero or greater: total value ' +
      `${signedTotal.toFixed(6)} over quantity ${signedQty.toFixed(6)} implies a NEGATIVE unit cost. ` +
      'This movement value is REFUSED rather than absolutised, so the caller cannot store it; any row ' +
      'the caller already created rolls back with its enclosing transaction. A credit-derived ' +
      '(negative-basis) cost ' +
      'layer cannot be represented downstream: cogs_entries would keep the negative sign for this same ' +
      'consumption, and the Xero and QuickBooks daily syncs emit a COGS journal pair only when the ' +
      'batch total is above zero, so the journal would be dropped silently. Correct the credit cost ' +
      'line that drove the basis negative (o3d-gd2f).',
    )
  }
  const unitCostBase = qty.gt(0)
    ? roundMovementValue(requestedTotal.div(qty))
    : toDecimal(0)
  // The DB invariant `stock_movements_reporting_value_consistent` requires
  // totalValueBase = ROUND(qty * unitCostBase, 6). Since unitCostBase is stored
  // rounded to 6dp, a weighted-average cost (e.g. £10 over 3 units → 3.333333)
  // makes qty * unitCostBase (9.999999) differ from the requested total (10.0),
  // which previously violated the check on mixed-cost FIFO consumption (notably
  // supplier returns). Derive the stored total FROM the rounded unit cost so the
  // two are always consistent; the exact per-layer cost remains in cogs_entries.
  const totalValueBase = roundMovementValue(multiplyMoney(qty, unitCostBase))

  return {
    unitCostBase: decimalField(unitCostBase),
    totalValueBase: decimalField(totalValueBase),
  }
}

export function buildStockMovementValueFieldsFromConsumed(
  consumed: ConsumedLayerValue[],
  rowQty?: DecimalInput,
): StockMovementValueFields {
  // FIFO consumption normally supplies positive quantities. Empty input is a
  // valid legacy-stock path and records zero value; mixed-sign entries are
  // treated as net weighted cost for defensive correction callers.
  //
  // o3d-gd2f: what is judged is the NET basis, NOT the presence of a negative layer. A
  // negative `unitCostBase` on one consumed layer does NOT by itself make the net total
  // negative: a mix that still nets positive (4 @ +3 together with 1 @ −1 → +11 over 5
  // units) is accepted unchanged, and that is pinned by the mixed-net-positive test in
  // tests/domain/inventory/stock-movement-value.test.ts. Only when the net total and the
  // row qty DISAGREE IN SIGN — i.e. the net implied unit cost is negative — does the
  // delegation below REFUSE rather than absolutise.
  //
  // That refusal is deliberate: this function's callers write `cogs_entries` from the same
  // `consumed` array via `cogsEntryDataFromConsumed`, which keeps the sign, so
  // absolutising here put the movement ledger and the COGS subledger in disagreement
  // for one consumption. The refusal lives in the delegate so every caller of either
  // form gets it.
  const totalQty = consumed.reduce((sum, entry) => sum.add(entry.qty), toDecimal(0))
  const totalValueBase = consumed.reduce(
    (sum, entry) => sum.add(multiplyMoney(entry.qty, entry.unitCostBase)),
    toDecimal(0),
  )

  // The DB CHECK stock_movements_reporting_value_consistent evaluates
  // ROUND(<stored qty> * unitCostBase, 6) against totalValueBase. FIFO tolerates
  // a sub-0.0001 fractional shortfall, so the consumed qty can be slightly below
  // the movement's stored qty — and for fractional quantities that gap can flip
  // the rounded product and re-trigger the violation. Build the value fields
  // against the MOVEMENT's stored row qty (when the caller supplies it) so they
  // are consistent with the constraint by construction. The exact per-layer cost
  // stays in cogs_entries. rowQty defaults to the consumed qty for callers whose
  // stored qty already equals the consumed qty (integer quantities never short).
  return buildStockMovementValueFieldsFromTotal({ qty: rowQty ?? totalQty, totalValueBase })
}
