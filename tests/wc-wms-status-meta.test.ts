import assert from 'node:assert/strict'
import test from 'node:test'
import * as wmsStatusNs from '../lib/connectors/woocommerce/sync/wms-status.ts'

const { buildWmsStatusMetaValues, buildWmsStatusMetaPatch } = 'default' in wmsStatusNs
  ? (wmsStatusNs.default as typeof import('../lib/connectors/woocommerce/sync/wms-status.ts'))
  : wmsStatusNs

const INPUT = { status: 'DESPATCHED', statusLabel: 'Despatched', connectorLabel: 'Mintsoft', deepLinkUrl: 'https://wms/o/1' }

test('buildWmsStatusMetaValues emits the WMS-neutral _oti_wms_* keys', () => {
  assert.deepEqual(buildWmsStatusMetaValues(INPUT), [
    { key: '_oti_wms_status', value: 'DESPATCHED' },
    { key: '_oti_wms_status_label', value: 'Despatched' },
    { key: '_oti_wms_connector', value: 'Mintsoft' },
    { key: '_oti_wms_deeplink', value: 'https://wms/o/1' },
  ])
})

test('buildWmsStatusMetaValues coerces a null deep link to empty string', () => {
  const values = buildWmsStatusMetaValues({ ...INPUT, deepLinkUrl: null })
  assert.equal(values.find((v) => v.key === '_oti_wms_deeplink')?.value, '')
})

test('buildWmsStatusMetaPatch reuses existing meta ids so a re-push updates rather than duplicates', () => {
  const existing = [
    { id: 11, key: '_oti_wms_status', value: 'PICKING' },
    { id: 12, key: '_oti_wms_status_label', value: 'Picking' },
    { id: 99, key: '_unrelated', value: 'x' },
  ]
  const patch = buildWmsStatusMetaPatch(INPUT, existing)
  assert.deepEqual(patch.find((p) => p.key === '_oti_wms_status'), { id: 11, key: '_oti_wms_status', value: 'DESPATCHED' })
  assert.deepEqual(patch.find((p) => p.key === '_oti_wms_status_label'), { id: 12, key: '_oti_wms_status_label', value: 'Despatched' })
  // a key with no existing meta is added without an id
  assert.deepEqual(patch.find((p) => p.key === '_oti_wms_connector'), { key: '_oti_wms_connector', value: 'Mintsoft' })
})

test('buildWmsStatusMetaPatch with no existing meta adds all keys without ids', () => {
  const patch = buildWmsStatusMetaPatch(INPUT, undefined)
  assert.ok(patch.every((p) => !('id' in p)))
  assert.equal(patch.length, 4)
})
