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

export function buildStockMovementValueFieldsFromTotal(params: {
  qty: DecimalInput
  totalValueBase: DecimalInput
}): StockMovementValueFields {
  const qty = toDecimal(params.qty).abs()
  const requestedTotal = roundMovementValue(params.totalValueBase).abs()
  if (qty.isZero() && !requestedTotal.isZero()) {
    throw new Error('Stock movement total value requires a non-zero quantity')
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

export function buildStockMovementValueFieldsFromConsumed(consumed: ConsumedLayerValue[]): StockMovementValueFields {
  // FIFO consumption normally supplies positive quantities. Empty input is a
  // valid legacy-stock path and records zero value; mixed-sign entries are
  // treated as net weighted cost for defensive correction callers.
  const totalQty = consumed.reduce((sum, entry) => sum.add(entry.qty), toDecimal(0))
  const totalValueBase = consumed.reduce(
    (sum, entry) => sum.add(multiplyMoney(entry.qty, entry.unitCostBase)),
    toDecimal(0),
  )

  return buildStockMovementValueFieldsFromTotal({ qty: totalQty, totalValueBase })
}
