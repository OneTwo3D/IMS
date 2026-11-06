import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ERASURE_FAILURE_DESCRIPTION,
  ERASURE_RECORD_ACTION,
  ERASURE_RECORD_DESCRIPTION,
  ERASURE_RETAINED_ACTIONS,
  buildErasureRecordMetadata,
} from '../lib/domain/erasure/erasure-record.ts'
import { sanitizeActivityLogMetadata } from '../lib/activity-log.ts'

const NAME = 'Zebediah Quillfeather'

test('the record names the request, date and scope, with every external system not-attempted', () => {
  const meta = buildErasureRecordMetadata({
    requestId: 'req-1', erasedAt: new Date('2026-11-06T10:00:00Z'), trigger: 'ON_REQUEST', customerId: 'cust1', orderIds: ['o1', 'o2'],
    counts: { customers: 1, salesOrders: 2, shipments: 1, shoppingCustomerLinks: 1, shoppingOrderLinks: 2, wmsStatusSnapshots: 0, outboxRowsErased: 0, outboxRowsClaimedFenced: 0, activityRowsScrubbed: 0, accountingPayloadsScrubbed: 0, heldInvoicePayloadsScrubbed: 0, paymentNotesErased: 0, linkedFreeTextScrubbed: 0, notifications: 0 },
  })
  assert.equal(meta.requestId, 'req-1')
  assert.equal(meta.trigger, 'ON_REQUEST')
  assert.deepEqual(meta.systems, { storefront: 'not-attempted', accounting: 'not-attempted', warehouse: 'not-attempted', carrierPortal: 'not-attempted' })
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
