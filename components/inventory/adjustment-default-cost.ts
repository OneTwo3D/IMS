import type { AdjustmentDefaultUnitCost } from '@/app/actions/stock'

/**
 * o3d-0ypv9 (switch `stock_adjustment_reason_cost_required` on): what an adjustment form tells the operator about the unit cost a
 * blank addition is booked at. `undefined` = not looked up yet; `null` = the lookup failed or returned nothing.
 */
export function describeDefaultUnitCost(value: AdjustmentDefaultUnitCost | null | undefined): { placeholder: string; hint: string } {
  if (value === undefined) return { placeholder: 'latest layer cost', hint: '' }
  if (!value || !value.hasDefault) {
    return {
      placeholder: 'required for additions',
      hint: 'No cost layer to default to: enter a unit cost for an addition (0 only for genuinely free stock).',
    }
  }
  const where = value.source === 'any_warehouse' ? ' (from another warehouse)' : ''
  if (value.unitCostBase == null) {
    return { placeholder: 'latest layer cost', hint: `Blank uses the latest cost layer's unit cost${where}.` }
  }
  const figure = trimCost(value.unitCostBase)
  return { placeholder: figure, hint: `Blank uses ${figure}, the latest cost layer's unit cost${where}.` }
}

/** "2.500000" -> "2.50"; "0.123400" -> "0.1234". Display only; the server books the stored 6dp value. */
function trimCost(sixDp: string): string {
  const [whole, frac = ''] = sixDp.split('.')
  const trimmed = frac.replace(/0+$/, '')
  return `${whole}.${trimmed.length >= 2 ? trimmed : trimmed.padEnd(2, '0')}`
}
