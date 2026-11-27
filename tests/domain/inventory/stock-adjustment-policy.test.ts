import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getLatestLayerUnitCost,
  defaultCostCapMessage,
  editChangesValueRefusedMessage,
  editNotPlainAdjustmentRefusedMessage,
  matchAdjustmentReason,
  missingReasonMessage,
  readStockAdjustmentReasonCostRequired,
  resolveRequiredAdditionUnitCost,
  splitReasonFromNote,
  STOCK_ADJUSTMENT_REASON_COST_REQUIRED_KEY,
  unmappedReasonMessage,
} from '@/lib/domain/inventory/stock-adjustment-policy'
import { toDecimal } from '@/lib/domain/math/decimal'

// o3d-0ypv9 — the pure rules behind `stock_adjustment_reason_cost_required`.

test('the switch is on only for the exact value "true"; absent or anything else is off', async () => {
  const client = (value: string | null) => ({
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        assert.equal(where.key, STOCK_ADJUSTMENT_REASON_COST_REQUIRED_KEY)
        return value == null ? null : { value }
      },
    },
  }) as never
  assert.equal(STOCK_ADJUSTMENT_REASON_COST_REQUIRED_KEY, 'stock_adjustment_reason_cost_required')
  assert.equal(await readStockAdjustmentReasonCostRequired(client(null)), false)
  assert.equal(await readStockAdjustmentReasonCostRequired(client('false')), false)
  assert.equal(await readStockAdjustmentReasonCostRequired(client('TRUE')), false)
  assert.equal(await readStockAdjustmentReasonCostRequired(client('')), false)
  assert.equal(await readStockAdjustmentReasonCostRequired(client('true')), true)
})

test('an entered cost wins, 0 included; a blank takes the latest layer; neither refuses', () => {
  const latest = { unitCostBase: toDecimal('3.250000'), source: 'warehouse' as const }
  assert.equal(resolveRequiredAdditionUnitCost({ explicitUnitCostBase: 1.5, latest, productLabel: 'S1' }).toFixed(6), '1.500000')
  assert.equal(resolveRequiredAdditionUnitCost({ explicitUnitCostBase: 0, latest, productLabel: 'S1' }).toFixed(6), '0.000000')
  assert.equal(resolveRequiredAdditionUnitCost({ explicitUnitCostBase: null, latest, productLabel: 'S1' }).toFixed(6), '3.250000')
  assert.equal(resolveRequiredAdditionUnitCost({ explicitUnitCostBase: undefined, latest, productLabel: 'S1' }).toFixed(6), '3.250000')
  assert.throws(() => resolveRequiredAdditionUnitCost({ explicitUnitCostBase: null, latest: null, productLabel: 'S1' }), /Enter a unit cost for this addition of S1/)
  assert.throws(() => resolveRequiredAdditionUnitCost({ explicitUnitCostBase: -1, latest, productLabel: 'S1' }), /zero or greater/)
  assert.throws(() => resolveRequiredAdditionUnitCost({ explicitUnitCostBase: Number.NaN, latest, productLabel: 'S1' }), /zero or greater/)
})

test('latest layer: this warehouse first, then any warehouse, newest first, zero-cost layers skipped', async () => {
  const calls: Array<Record<string, unknown>> = []
  const client = (inWarehouse: string | null, anywhere: string | null) => ({
    costLayer: {
      findFirst: async (args: { where: Record<string, unknown>; orderBy: unknown }) => {
        calls.push(args as Record<string, unknown>)
        const row = 'warehouseId' in args.where ? inWarehouse : anywhere
        return row == null ? null : { unitCostBase: row }
      },
    },
  }) as never
  calls.length = 0
  const own = await getLatestLayerUnitCost(client('2.100000', '9.000000'), 'p', 'w')
  assert.deepEqual([own?.unitCostBase.toFixed(6), own?.source], ['2.100000', 'warehouse'])
  assert.equal(calls.length, 1, 'the other warehouses are not read when this one has a costed layer')
  // o3d-jwa8m MED-4: receipt or production layers only; ties by the creation sequence, never the cuid.
  const qualifying = {
    unitCostBase: { gt: 0 },
    adjustmentMovementId: null,
    returnMovementId: null,
    isOpeningStock: false,
    OR: [{ poLineId: { not: null } }, { productionOrderId: { not: null } }],
  }
  assert.deepEqual(calls[0]!.where, { productId: 'p', warehouseId: 'w', ...qualifying })
  assert.deepEqual(calls[0]!.orderBy, [{ receivedAt: 'desc' }, { createdSeq: 'desc' }])

  calls.length = 0
  const other = await getLatestLayerUnitCost(client(null, '9.000000'), 'p', 'w')
  assert.deepEqual([other?.unitCostBase.toFixed(6), other?.source], ['9.000000', 'any_warehouse'])
  assert.deepEqual(calls[1]!.where, { productId: 'p', ...qualifying })

  assert.equal(await getLatestLayerUnitCost(client(null, null), 'p', 'w'), null)
})

test('a CSV reason cell matches an active reason by name (case-insensitive) or id, and refuses ambiguity', () => {
  const reasons = [
    { id: 'r1', name: 'Damaged' },
    { id: 'r2', name: 'Stock count' },
    { id: 'r3', name: 'Dup' },
    { id: 'r4', name: 'dup ' },
  ]
  assert.deepEqual(matchAdjustmentReason('damaged', reasons), { ok: true, reasonId: 'r1' })
  assert.deepEqual(matchAdjustmentReason('  STOCK COUNT ', reasons), { ok: true, reasonId: 'r2' })
  assert.deepEqual(matchAdjustmentReason('r1', reasons), { ok: true, reasonId: 'r1' })
  const missing = matchAdjustmentReason('', reasons)
  assert.equal(missing.ok, false)
  assert.equal(!missing.ok && missing.message, 'missing reason')
  assert.equal(matchAdjustmentReason(undefined, reasons).ok, false)
  const unknown = matchAdjustmentReason('Lost', reasons)
  assert.match(!unknown.ok ? unknown.message : '', /"Lost" is not an active adjustment reason/)
  const dup = matchAdjustmentReason('dup', reasons)
  assert.match(!dup.ok ? dup.message : '', /matches 2 active reasons/)
})

test('the refusal messages name what to fix', () => {
  assert.match(missingReasonMessage('SKU-1'), /Choose an adjustment reason for SKU-1/)
  assert.match(unmappedReasonMessage({ reasonName: 'Damaged', inventoryAccountMapped: true }), /Map an account to "Damaged"/)
  assert.match(unmappedReasonMessage({ reasonName: 'Damaged', inventoryAccountMapped: false }), /Map the inventory account first/)
})

test('LOW-8: a retired chart is told to re-map for the active connector, not to map an account', () => {
  const message = unmappedReasonMessage({ reasonName: 'Damaged', inventoryAccountMapped: true, chartRetired: true })
  assert.match(message, /no longer the active one/)
  assert.doesNotMatch(message, /Map an account to/)
  assert.match(message, /Nothing was saved/)
})

test('LOW-10: the reason is read back from the note prefix (longest name wins) for the adjustments export', () => {
  const names = ['Damaged', 'Damaged in transit', 'Stock count']
  assert.deepEqual(splitReasonFromNote('Damaged', names), { reason: 'Damaged', note: '' })
  assert.deepEqual(splitReasonFromNote('Damaged: forklift', names), { reason: 'Damaged', note: 'forklift' })
  assert.deepEqual(splitReasonFromNote('Damaged in transit: wet', names), { reason: 'Damaged in transit', note: 'wet' })
  assert.deepEqual(splitReasonFromNote('Damagedx', names), { reason: '', note: 'Damagedx' })
  assert.deepEqual(splitReasonFromNote(null, names), { reason: '', note: '' })
})

test('LOW-12 and MED-3: the cap and edit refusals say what to do', () => {
  assert.match(defaultCostCapMessage(200), /at most 200 .* batches of 200/)
  assert.match(editNotPlainAdjustmentRefusedMessage('PurchaseReturn'), /supplier return/)
  assert.match(editNotPlainAdjustmentRefusedMessage('StockCount'), /stock-count variance/)
  assert.match(editNotPlainAdjustmentRefusedMessage('WmsSyncJob'), /align-down/)
  assert.match(editNotPlainAdjustmentRefusedMessage('Other'), /another process/)
  assert.match(editChangesValueRefusedMessage(), /Reverse this adjustment/)
})
