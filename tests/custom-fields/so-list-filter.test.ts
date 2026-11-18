import assert from 'node:assert/strict'
import test from 'node:test'
import { filterableCustomFields, resolveCustomFieldListFilter } from '../../lib/custom-fields/filter.ts'
import type { CustomFieldDefinitionRow } from '../../lib/custom-fields/values-service.ts'
import { buildSalesOrderListWhere } from '../../lib/domain/lists/order-list-query.ts'
import { EMPTY_ORDER_LIST_URL_STATE, orderListHref } from '../../lib/domain/lists/order-list-url.ts'

/** THE SALES-ORDER LIST FILTER BY A CUSTOM FIELD VALUE (dropdown and yes / no fields). */

const row = (over: Partial<CustomFieldDefinitionRow> & Pick<CustomFieldDefinitionRow, 'id' | 'key' | 'type'>): CustomFieldDefinitionRow => ({
  entity: 'SALES_ORDER', namespace: 'ops', label: over.key, options: null, required: false, sortOrder: 0, active: true, ...over,
})

const definitions = [
  row({ id: 'dStage', key: 'stage', type: 'STRING', label: 'Process stage', options: ['Pick', 'Pack'] }),
  row({ id: 'dGift', key: 'gift', type: 'BOOLEAN', label: 'Gift' }),
  row({ id: 'dFree', key: 'remark', type: 'STRING' }),
  row({ id: 'dNum', key: 'boxes', type: 'NUMBER' }),
  row({ id: 'dOld', key: 'old', type: 'STRING', options: ['x'], active: false }),
]

test('only dropdown (text with choices) and yes / no fields are offered, active ones only', () => {
  const offered = filterableCustomFields(definitions)
  assert.deepEqual(offered.map((f) => f.key), ['stage', 'gift'])
  assert.deepEqual(offered[0]!.choices.map((c) => c.value), ['Pick', 'Pack'])
  assert.deepEqual(offered[1]!.choices, [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }])
})

test('a dropdown value resolves to an exact text match, a yes / no value to a boolean match', () => {
  assert.deepEqual(resolveCustomFieldListFilter(definitions, 'stage', 'Pack'), { definitionId: 'dStage', valueText: 'Pack' })
  assert.deepEqual(resolveCustomFieldListFilter(definitions, 'gift', 'true'), { definitionId: 'dGift', valueBoolean: true })
  assert.deepEqual(resolveCustomFieldListFilter(definitions, 'gift', 'false'), { definitionId: 'dGift', valueBoolean: false })
})

test('an unknown key, a switched-off field, a free-text or number field, or a value that is not a choice is ignored (the list is not filtered)', () => {
  for (const [key, value] of [['nope', 'x'], ['old', 'x'], ['remark', 'x'], ['boxes', '3'], ['stage', 'Ship'], ['gift', 'maybe'], ['stage', ''], [undefined, 'x'], ['stage', undefined]] as const) {
    assert.equal(resolveCustomFieldListFilter(definitions, key, value), null, `${key}=${value}`)
  }
})

test('the list WHERE matches orders holding that value of that definition, and adds nothing when there is no filter', () => {
  const where = JSON.stringify(buildSalesOrderListWhere({ customField: { definitionId: 'dStage', valueText: 'Pack' } }))
  assert.match(where, /"customFieldValues":\{"some":\{"definitionId":"dStage","valueText":"Pack"\}\}/)
  const bool = JSON.stringify(buildSalesOrderListWhere({ customField: { definitionId: 'dGift', valueBoolean: false } }))
  assert.match(bool, /"some":\{"definitionId":"dGift","valueBoolean":false\}/, 'a false value is still a filter, not "no filter"')
  assert.ok(!JSON.stringify(buildSalesOrderListWhere({})).includes('customFieldValues'))
})

test('the filter composes with the status and search filters (all are ANDed)', () => {
  const where = buildSalesOrderListWhere({ statuses: ['PROCESSING'], q: 'abc', customField: { definitionId: 'dStage', valueText: 'Pick' } })
  assert.ok(Array.isArray(where.AND))
  assert.equal((where.AND as unknown[]).length >= 3, true)
})

test('the list address carries the field and the value, and a plain list carries neither', () => {
  assert.equal(orderListHref('/sales', { ...EMPTY_ORDER_LIST_URL_STATE, customFieldKey: 'stage', customFieldValue: 'Pack' }), '/sales?cf=stage&cfv=Pack')
  assert.equal(orderListHref('/sales', EMPTY_ORDER_LIST_URL_STATE), '/sales')
  assert.equal(orderListHref('/sales', { ...EMPTY_ORDER_LIST_URL_STATE, customFieldKey: 'stage' }), '/sales')
})
