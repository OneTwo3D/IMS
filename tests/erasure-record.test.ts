import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  defaultSystemVerdicts,
  identityFreeOrderToken,
  ERASURE_FAILURE_DESCRIPTION,
  ERASURE_RECORD_ACTION,
  ERASURE_RECORD_DESCRIPTION,
  ERASURE_RETAINED_ACTIONS,
  buildErasureRecordMetadata,
} from '../lib/domain/erasure/erasure-record.ts'
import { sanitizeActivityLogMetadata } from '../lib/activity-log.ts'

const NAME = 'Zebediah Quillfeather'

test('the record names the request, date and scope, with the verdicts the trigger alone decides', () => {
  const meta = buildErasureRecordMetadata({
    requestId: 'req-1', erasedAt: new Date('2026-11-06T10:00:00Z'), trigger: 'ON_REQUEST', customerId: 'cust1', orderIds: ['o1', 'o2'],
    counts: { customers: 1, salesOrders: 2, shipments: 1, shoppingCustomerLinks: 1, shoppingOrderLinks: 2, wmsStatusSnapshots: 0, outboxRowsErased: 0, outboxRowsClaimedFenced: 0, activityRowsScrubbed: 0, accountingPayloadsScrubbed: 0, heldInvoicePayloadsScrubbed: 0, paymentNotesErased: 0, bounceRecordsDeleted: 0, linkedFreeTextScrubbed: 0, rawWebhookEventsProjected: 0, rawSyncLogsProjected: 0, rawReturnRecordsCleared: 0, storefrontIdMissing: 0, accountingEventCopiesScrubbed: 0, accountingErrorsScrubbed: 0, notifications: 0 },
  })
  assert.equal(meta.requestId, 'req-1')
  assert.equal(meta.trigger, 'ON_REQUEST')
  assert.deepEqual(meta.systems, { storefront: 'not-attempted', accounting: 'not-applicable', warehouse: 'not-applicable', carrierPortal: 'not-attempted' })
  assert.deepEqual(meta.warehouse, { linkedOrders: 0, despatched: 0, open: 0, cancelled: 0, notPushed: 0, ambiguous: 0, merged: 0, openOrders: [], ambiguousOrders: [] })
  // A mirrored or created-after-erasure order was erased at the storefront first.
  for (const trigger of ['MIRRORED_FROM_STOREFRONT', 'IMPORT_AFTER_ERASURE'] as const) assert.equal(defaultSystemVerdicts(trigger).storefront, 'erased-at-source')
  // The activity-log sanitiser must leave every value intact: a key that matched its sensitive pattern would be blanked.
  assert.deepEqual(sanitizeActivityLogMetadata(meta), JSON.parse(JSON.stringify(meta)))
})

test('the descriptions are fixed strings that carry no subject', () => {
  for (const text of [ERASURE_RECORD_DESCRIPTION, ERASURE_FAILURE_DESCRIPTION]) assert.ok(!text.includes('${') && !text.includes(NAME))
})

test('the retention exemption is one shared constant, spread by the cleanup and used by the writer', () => {
  assert.deepEqual([...ERASURE_RETAINED_ACTIONS], [ERASURE_RECORD_ACTION])
  const cleanup = readFileSync(new URL('../lib/activity-log-cleanup.ts', import.meta.url), 'utf8')
  assert.match(cleanup, /\.\.\.ERASURE_RETAINED_ACTIONS/)
  assert.ok(!cleanup.includes(ERASURE_RECORD_ACTION), 'the cleanup must not retype the action name')
  const core = readFileSync(new URL('../lib/domain/erasure/erase-personal-data.ts', import.meta.url), 'utf8')
  assert.match(core, /action: ERASURE_RECORD_ACTION/)
  assert.ok(!core.includes(`'${ERASURE_RECORD_ACTION}'`), 'the writer must use the constant')
})

test('the superseded action name is not exempted, so name-bearing legacy rows still age out', () => {
  assert.ok(!ERASURE_RETAINED_ACTIONS.includes('gdpr_anonymised'))
})

test('the failure path never logs or returns the exception text', () => {
  const core = readFileSync(new URL('../lib/domain/erasure/erase-personal-data.ts', import.meta.url), 'utf8')
  assert.ok(!/String\(e\)/.test(core) && !/e\.message/.test(core))
})

test('only a plain token may be written to the record as an order number', () => {
  for (const ok of ['MS-123', 'SO-2026/45', 'A_B.C#1', 'MS-5+MS-6', 'x'.repeat(40)]) assert.equal(identityFreeOrderToken(ok), ok)
  for (const bad of ['Zebediah Quillfeather', 'z@example.test', 'a b', '', 'x'.repeat(41), 'Zeb\n1', null, undefined, 5]) assert.equal(identityFreeOrderToken(bad), null)
})
