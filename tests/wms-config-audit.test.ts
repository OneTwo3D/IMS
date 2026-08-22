import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configChangeMetadata,
  describeConfigChange,
  diffConfigSnapshots,
  diffRoutingMap,
  parseRoutingMap,
} from '@/lib/domain/wms/config-audit'

// q66in.7.2: connection and binding saves recorded AFTER-VALUES ONLY, and the courier-map / order-
// dispatch saves recorded nothing at all. These pin the diff the activity entries are now built
// from — specifically that the BEFORE half exists, that secrets never reach it, and that a REMOVED
// routing entry is reported rather than vanishing.

test('a diff reports what a field moved FROM, not just what it is now', async () => {
  const diff = diffConfigSnapshots(
    { stockSyncMode: 'ALIGN_TO_WMS', syncFrequencyMinutes: 60, active: true },
    { stockSyncMode: 'NOTIFICATION_ONLY', syncFrequencyMinutes: 60, active: true },
  )

  assert.equal(diff.created, false)
  assert.deepEqual(diff.changed, ['stockSyncMode'])
  // The half that did not exist before: the PRIOR value.
  assert.deepEqual(diff.before, { stockSyncMode: 'ALIGN_TO_WMS' })
  assert.deepEqual(diff.after, { stockSyncMode: 'NOTIFICATION_ONLY' })
  // Unchanged fields are absent from both halves — the entry says what changed, not what exists.
  assert.equal('syncFrequencyMinutes' in diff.before, false)
  assert.equal('active' in diff.after, false)
})

test('a create is reported as created, not as every field changing from nothing', async () => {
  const diff = diffConfigSnapshots(null, { stockSyncMode: 'DISABLED', active: true })
  assert.equal(diff.created, true)
  assert.deepEqual(diff.before, {})
  assert.deepEqual(diff.changed, ['active', 'stockSyncMode'])
  assert.equal(describeConfigChange(diff), 'created')
})

test('a field REMOVED from the config diffs to null instead of disappearing', async () => {
  const diff = diffConfigSnapshots(
    { alignDownReasonId: 'reason-1', clientId: '89' },
    { clientId: '89' },
  )
  assert.deepEqual(diff.changed, ['alignDownReasonId'])
  assert.deepEqual(diff.before, { alignDownReasonId: 'reason-1' })
  assert.deepEqual(diff.after, { alignDownReasonId: null })
})

test('arrays and nested thresholds compare structurally, so a reorder is NOT logged as a change', async () => {
  const unchanged = diffConfigSnapshots(
    { reportRecipients: ['a@x.test', 'b@x.test'], discrepancyThresholds: { qty: 5 } },
    { reportRecipients: ['a@x.test', 'b@x.test'], discrepancyThresholds: { qty: 5 } },
  )
  assert.deepEqual(unchanged.changed, [])
  assert.equal(describeConfigChange(unchanged), 'no changes')

  const changed = diffConfigSnapshots(
    { discrepancyThresholds: { qty: 5 } },
    { discrepancyThresholds: { qty: 25 } },
  )
  assert.deepEqual(changed.changed, ['discrepancyThresholds'])
  assert.deepEqual(changed.before, { discrepancyThresholds: { qty: 5 } })
})

test('a credential-shaped key is MASKED in both halves of the diff, not logged', async () => {
  // Call sites pass presence booleans, never values. This is the defence-in-depth layer: a call
  // site that passes an actual secret by mistake must not put it in the activity log.
  const diff = diffConfigSnapshots(
    { webhookSecret: 'old-secret-value', staticApiKey: 'old-key' },
    { webhookSecret: 'new-secret-value', staticApiKey: 'new-key' },
  )
  assert.deepEqual(diff.changed, ['staticApiKey', 'webhookSecret'])
  assert.equal(diff.before.webhookSecret, '[masked]')
  assert.equal(diff.after.webhookSecret, '[masked]')
  assert.equal(diff.before.staticApiKey, '[masked]')
  assert.equal(diff.after.staticApiKey, '[masked]')

  // ...while the presence markers the call sites actually use survive, because their names are
  // chosen NOT to trip the mask — a `[masked]` boolean would carry no information at all.
  const presence = diffConfigSnapshots(
    { webhookSigningConfigured: false, fixedKeyConfigured: false, credentialsConfigured: true },
    { webhookSigningConfigured: true, fixedKeyConfigured: true, credentialsConfigured: true },
  )
  assert.deepEqual(presence.changed, ['fixedKeyConfigured', 'webhookSigningConfigured'])
  assert.equal(presence.before.webhookSigningConfigured, false)
  assert.equal(presence.after.webhookSigningConfigured, true)
})

test('configChangeMetadata carries the diff plus the caller extras', async () => {
  const diff = diffConfigSnapshots({ active: true }, { active: false })
  const metadata = configChangeMetadata(diff, { warehouseId: 'wh-1' })
  assert.equal(metadata.warehouseId, 'wh-1')
  assert.equal(metadata.created, false)
  assert.deepEqual(metadata.changed, ['active'])
  assert.deepEqual(metadata.before, { active: true })
  assert.deepEqual(metadata.after, { active: false })
})

test('describeConfigChange caps the field list instead of producing an unbounded description', async () => {
  const before = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`field${i}`, i]))
  const after = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`field${i}`, i + 1]))
  const summary = describeConfigChange(diffConfigSnapshots(before, after))
  assert.match(summary, /^changed field0, field1, field2, field3, field4, field5 \(\+4 more\)$/)
})

test('a REMOVED courier mapping is reported — it silently falls back to the default courier id', async () => {
  const routing = diffRoutingMap(
    { 'Next Day': 12, 'Standard': 3, 'Saturday': 44 },
    { 'Next Day': 99, 'Standard': 3, 'Express': 7 },
  )
  assert.deepEqual(routing.added, ['Express'])
  assert.deepEqual(routing.changed, ['Next Day'])
  assert.deepEqual(
    routing.removed,
    ['Saturday'],
    'a dropped entry is the change that looks like nothing happened until the labels come out wrong',
  )
})

test('a malformed stored courier map diffs as empty rather than throwing during a save', async () => {
  assert.deepEqual(parseRoutingMap('not json'), {})
  assert.deepEqual(parseRoutingMap(''), {})
  assert.deepEqual(parseRoutingMap(null), {})
  assert.deepEqual(parseRoutingMap('[1,2]'), {}, 'an array is not a routing map')
  assert.deepEqual(parseRoutingMap('{"Next Day":12}'), { 'Next Day': 12 })
})
