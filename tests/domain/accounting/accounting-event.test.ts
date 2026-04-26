import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertUniqueAccountingEventIdempotencyKeys,
  buildAccountingEvent,
  buildAccountingEventIdempotencyKey,
  buildAccountingEventLog,
} from '@/lib/domain/accounting/accounting-event-builder'

test('buildAccountingEvent normalizes balanced event lines', () => {
  const event = buildAccountingEvent({
    type: 'DAILY_BATCH_GROUP_B',
    sourceEntityType: 'Shipment',
    sourceEntityId: 'shipment-1',
    businessDate: '2026-04-26',
    currency: 'GBP',
    idempotencyKey: buildAccountingEventIdempotencyKey(['shipment', 'shipment-1', 'group-b']),
    lines: [
      { accountCode: '500', description: 'COGS', debit: 10.005 },
      { accountCode: '631', description: 'Allocated inventory', credit: 10.005 },
    ],
  })

  assert.equal(event.status, 'PENDING')
  assert.equal(event.currency, 'GBP')
  assert.equal(event.idempotencyKey, 'shipment:shipment-1:group-b')
  assert.equal(event.businessDate.toISOString(), '2026-04-26T00:00:00.000Z')
  assert.deepEqual(event.linesJson, [
    { accountCode: '500', description: 'COGS', debit: 10.01 },
    { accountCode: '631', description: 'Allocated inventory', credit: 10.01 },
  ])
})

test('buildAccountingEvent uses the provided currency minor units', () => {
  const event = buildAccountingEvent({
    type: 'DAILY_BATCH_GROUP_B',
    sourceEntityType: 'Shipment',
    sourceEntityId: 'shipment-1',
    businessDate: '2026-04-26',
    currency: 'KWD',
    idempotencyKey: 'shipment-1-kwd',
    lines: [
      { accountCode: '500', description: 'COGS', debit: 1.2345 },
      { accountCode: '631', description: 'Allocated inventory', credit: 1.2345 },
    ],
  })

  assert.deepEqual(event.linesJson, [
    { accountCode: '500', description: 'COGS', debit: 1.235 },
    { accountCode: '631', description: 'Allocated inventory', credit: 1.235 },
  ])
})

test('buildAccountingEvent balance checks use decimal accumulation', () => {
  const event = buildAccountingEvent({
    type: 'DAILY_BATCH_GROUP_B',
    sourceEntityType: 'Shipment',
    sourceEntityId: 'shipment-1',
    businessDate: '2026-04-26',
    currency: 'GBP',
    idempotencyKey: 'shipment-1-decimal',
    lines: [
      { accountCode: '500', description: 'COGS A', debit: 0.1 },
      { accountCode: '500', description: 'COGS B', debit: 0.2 },
      { accountCode: '631', description: 'Allocated inventory', credit: 0.3 },
    ],
  })

  assert.deepEqual(event.linesJson, [
    { accountCode: '500', description: 'COGS A', debit: 0.1 },
    { accountCode: '500', description: 'COGS B', debit: 0.2 },
    { accountCode: '631', description: 'Allocated inventory', credit: 0.3 },
  ])
})

test('buildAccountingEventIdempotencyKey treats Date parts as UTC date-only', () => {
  assert.equal(
    buildAccountingEventIdempotencyKey(['daily-batch', new Date('2026-04-26T21:29:56.789Z')]),
    'daily-batch:2026-04-26',
  )
})

test('buildAccountingEvent rejects malformed or unbalanced lines', () => {
  assert.throws(() => buildAccountingEvent({
    type: 'DAILY_BATCH_GROUP_B',
    sourceEntityType: 'Shipment',
    sourceEntityId: 'shipment-1',
    businessDate: '2026-04-26',
    currency: 'GBP',
    idempotencyKey: 'shipment-1',
    lines: [{ accountCode: '500', description: 'COGS', debit: 10, credit: 10 }],
  }), /exactly one positive debit or credit/)

  assert.throws(() => buildAccountingEvent({
    type: 'DAILY_BATCH_GROUP_B',
    sourceEntityType: 'Shipment',
    sourceEntityId: 'shipment-1',
    businessDate: '2026-04-26',
    currency: 'GBP',
    idempotencyKey: 'shipment-1',
    lines: [
      { accountCode: '500', description: 'COGS', debit: 10 },
      { accountCode: '631', description: 'Allocated inventory', credit: 9 },
    ],
  }), /must balance/)
})

test('assertUniqueAccountingEventIdempotencyKeys detects duplicate keys', () => {
  assert.doesNotThrow(() => assertUniqueAccountingEventIdempotencyKeys([
    { idempotencyKey: 'event-1' },
    { idempotencyKey: 'event-2' },
  ]))

  assert.throws(() => assertUniqueAccountingEventIdempotencyKeys([
    { idempotencyKey: 'event-1' },
    { idempotencyKey: 'event-1' },
  ]), /Duplicate accounting event idempotency key/)
})

test('buildAccountingEventLog validates log metadata shape', () => {
  assert.deepEqual(buildAccountingEventLog({
    accountingEventId: 'event-1',
    action: 'created',
    message: 'Created from daily batch mirror',
    metadata: { syncLogId: 'sync-1' },
  }), {
    accountingEventId: 'event-1',
    action: 'created',
    message: 'Created from daily batch mirror',
    metadata: { syncLogId: 'sync-1' },
  })
})
