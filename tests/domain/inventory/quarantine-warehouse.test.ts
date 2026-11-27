import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { findSwitch } from '@/lib/domain/settings/system-switches'
import {
  isQuarantineWarehouseType,
  WMS_UNSELLABLE_RETURN_REFUSAL,
  wmsReturnRestockRefusal,
  quarantineTypeChangeRefusal,
  loadQuarantineQtyByProduct,
  parseReturnCondition,
  quarantineWarehouseSettingsRefusal,
  readReturnConditionCheckEnabled,
  RETURN_CONDITION_CHECK_SETTING_KEY,
  RETURN_CONDITION_MISSING_REFUSAL,
  returnConditionCheckEnabledFromSetting,
  returnConditionRestockRefusal,
  sellableStockLevelWhere,
  sellableWarehouseWhere,
} from '@/lib/domain/inventory/quarantine-warehouse'

/**
 * The return condition check (switch return_condition_check_enabled): the pure rules. With the switch off every rule answers
 * "nothing changes" (no refusal, an empty filter, an empty map without a query), which is what keeps the off path identical.
 */

const QAR = { code: 'QAR', type: 'QUARANTINE' }
const MAIN = { code: 'MAIN', type: 'STANDARD' }

test('the switch is on only for exactly "true"', async () => {
  assert.equal(RETURN_CONDITION_CHECK_SETTING_KEY, 'return_condition_check_enabled')
  assert.equal(returnConditionCheckEnabledFromSetting('true'), true)
  for (const value of ['false', 'TRUE', '1', '', null, undefined]) assert.equal(returnConditionCheckEnabledFromSetting(value), false)
  assert.equal(await readReturnConditionCheckEnabled({}), false, 'a client without settings reads off')
  assert.equal(await readReturnConditionCheckEnabled(null), false)
  const asked: string[] = []
  const client = { setting: { findUnique: async (args: { where: { key: string } }) => { asked.push(args.where.key); return { value: 'true' } } } }
  assert.equal(await readReturnConditionCheckEnabled(client), true)
  assert.deepEqual(asked, ['return_condition_check_enabled'])
})

test('a quarantine warehouse is the QUARANTINE type only', () => {
  assert.equal(isQuarantineWarehouseType('QUARANTINE'), true)
  for (const type of ['STANDARD', 'RESTOCK', null, undefined, 'quarantine']) assert.equal(isQuarantineWarehouseType(type), false)
  assert.equal(parseReturnCondition('SELLABLE'), 'SELLABLE')
  assert.equal(parseReturnCondition('UNSELLABLE'), 'UNSELLABLE')
  for (const value of ['sellable', '', null, undefined, 1]) assert.equal(parseReturnCondition(value), null)
})

test('restock rule: off never refuses; on, the condition must be stated and agree with the warehouse', () => {
  for (const condition of [null, 'SELLABLE', 'UNSELLABLE'] as const) {
    for (const warehouse of [QAR, MAIN]) assert.equal(returnConditionRestockRefusal({ enabled: false, condition, warehouse }), null)
  }
  assert.equal(returnConditionRestockRefusal({ enabled: true, condition: null, warehouse: MAIN }), RETURN_CONDITION_MISSING_REFUSAL)
  assert.equal(returnConditionRestockRefusal({ enabled: true, condition: 'SELLABLE', warehouse: MAIN }), null)
  assert.equal(returnConditionRestockRefusal({ enabled: true, condition: 'UNSELLABLE', warehouse: QAR }), null)
  assert.match(returnConditionRestockRefusal({ enabled: true, condition: 'UNSELLABLE', warehouse: MAIN }) ?? '', /MAIN is not one/)
  assert.match(returnConditionRestockRefusal({ enabled: true, condition: 'SELLABLE', warehouse: QAR }) ?? '', /QAR is a quarantine warehouse/)
})

test('warehouse settings: on, a quarantine warehouse cannot carry a sellable flag', () => {
  const flags = { availableForSale: false, syncToStore: false, isDefault: false }
  assert.equal(quarantineWarehouseSettingsRefusal({ enabled: true, type: 'QUARANTINE', ...flags }), null)
  assert.equal(quarantineWarehouseSettingsRefusal({ enabled: false, type: 'QUARANTINE', availableForSale: true, syncToStore: true, isDefault: true }), null, 'off: unchanged')
  assert.equal(quarantineWarehouseSettingsRefusal({ enabled: true, type: 'STANDARD', availableForSale: true, syncToStore: true, isDefault: true }), null)
  const refusal = quarantineWarehouseSettingsRefusal({ enabled: true, type: 'QUARANTINE', availableForSale: true, syncToStore: true, isDefault: false })
  assert.match(refusal ?? '', /Available for sale, Sync to store/)
  assert.doesNotMatch(refusal ?? '', /Default/)
})

test('filters are empty with the switch off and leave quarantine out with it on', () => {
  assert.deepEqual(sellableWarehouseWhere(false), {})
  assert.deepEqual(sellableStockLevelWhere(false), {})
  assert.deepEqual(sellableWarehouseWhere(true), { type: { not: 'QUARANTINE' } })
  assert.deepEqual(sellableStockLevelWhere(true), { warehouse: { type: { not: 'QUARANTINE' } } })
})

test('quarantine quantities: no query with the switch off; on, the quarantine levels per product', async () => {
  const calls: unknown[] = []
  const client = {
    stockLevel: {
      groupBy: async (args: unknown) => {
        calls.push(args)
        return [
          { productId: 'p1', _sum: { quantity: new Prisma.Decimal('2.5') } },
          { productId: 'p2', _sum: { quantity: new Prisma.Decimal('0') } },
        ]
      },
    },
  } as never
  assert.equal((await loadQuarantineQtyByProduct(client, false, ['p1'])).size, 0)
  assert.equal((await loadQuarantineQtyByProduct(client, true, [])).size, 0)
  assert.equal(calls.length, 0, 'no query when off or when no product is asked for')
  const map = await loadQuarantineQtyByProduct(client, true, ['p1', 'p2'])
  assert.equal(map.get('p1')?.toString(), '2.5')
  assert.equal(map.has('p2'), false, 'a zero sum is no quarantine')
  assert.deepEqual(calls[0], { by: ['productId'], where: { productId: { in: ['p1', 'p2'] }, warehouse: { type: 'QUARANTINE' } }, _sum: { quantity: true } })
  await loadQuarantineQtyByProduct(client, true, null)
  assert.deepEqual(calls[1], { by: ['productId'], where: { warehouse: { type: 'QUARANTINE' } }, _sum: { quantity: true } })
})

test('the switch is an ADMIN system switch (command line, --confirm-admin), keyed as the reader reads it', () => {
  const def = findSwitch(RETURN_CONDITION_CHECK_SETTING_KEY)
  assert.ok(def, 'registered')
  assert.equal(def.adminOnly, true)
  assert.equal(def.defaultValue, 'false')
  assert.deepEqual([...def.allowed], ['true', 'false'])
})

test('Mintsoft returns inbox: on, an unsellable unit is always refused (quarantine is IMS-only); off, nothing is refused', () => {
  for (const warehouse of [QAR, MAIN]) {
    assert.equal(wmsReturnRestockRefusal({ enabled: true, condition: 'UNSELLABLE', warehouse }), WMS_UNSELLABLE_RETURN_REFUSAL)
    assert.equal(wmsReturnRestockRefusal({ enabled: false, condition: 'UNSELLABLE', warehouse }), null)
  }
  assert.equal(wmsReturnRestockRefusal({ enabled: true, condition: 'SELLABLE', warehouse: MAIN }), null)
  assert.match(wmsReturnRestockRefusal({ enabled: true, condition: 'SELLABLE', warehouse: QAR }) ?? '', /quarantine warehouse/)
  assert.equal(wmsReturnRestockRefusal({ enabled: true, condition: null, warehouse: MAIN }), RETURN_CONDITION_MISSING_REFUSAL)
  assert.match(WMS_UNSELLABLE_RETURN_REFUSAL, /at the 3PL/)
  assert.match(WMS_UNSELLABLE_RETURN_REFUSAL, /mark it sellable/)
})

test('type change into quarantine: refused while any sellable work remains, and each is named', () => {
  const none = { wmsBindings: 0, allocations: 0, openShipments: 0, openProductionOrders: 0 }
  assert.equal(quarantineTypeChangeRefusal(none), null)
  for (const [key, label] of [['wmsBindings', 'binding'], ['allocations', 'allocation'], ['openShipments', 'shipment'], ['openProductionOrders', 'production order']] as const) {
    assert.match(quarantineTypeChangeRefusal({ ...none, [key]: 2 }) ?? '', new RegExp(`2 [a-z -]*${label}`))
  }
})
