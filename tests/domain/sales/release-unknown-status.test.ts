import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeUnknownReleaseStatuses,
  listUnknownReleaseStatuses,
  UNKNOWN_RELEASE_STATUS_ROW_WHERE,
} from '../../../lib/domain/sales/refund-reservation-release-outbox.ts'

type Row = { idempotencyKey: string; status: string }

function client(rows: Row[]) {
  return {
    salesOrderRefund: { findMany: async () => [{ id: 'r-1' }] },
    integrationOutbox: {
      count: async () => 0,
      findMany: async (args: { where: { idempotencyKey: { in: string[] }; status: { notIn: string[] } } }) =>
        rows.filter((row) => args.where.idempotencyKey.in.includes(row.idempotencyKey)
          && !args.where.status.notIn.includes(row.status)),
    },
  }
}

const KEY = 'sales:refund.reservation-release:r-1'

test('a release row in a status this binary cannot name is classified and surfaced, with the rollback remedy', async () => {
  const statuses = await listUnknownReleaseStatuses('order-1', { client: client([{ idempotencyKey: KEY, status: 'QUARANTINED' }]) })
  assert.deepEqual(statuses, ['QUARANTINED'])
  const text = describeUnknownReleaseStatuses(statuses)
  assert.match(text, /QUARANTINED/)
  assert.match(text, /roll forward/i)
  assert.match(text, /Sync > Exceptions/)
})

test('known statuses (including SUCCEEDED) are never reported as unknown', async () => {
  const rows = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'RETRYABLE_FAILED', 'PERMANENT_FAILED', 'SHADOWED']
    .map((status) => ({ idempotencyKey: KEY, status }))
  assert.deepEqual(await listUnknownReleaseStatuses('order-1', { client: client(rows) }), [])
  assert.equal(describeUnknownReleaseStatuses([]), '')
})

test('Sync Exceptions selector targets only refund-release rows with unknown statuses', () => {
  assert.equal(UNKNOWN_RELEASE_STATUS_ROW_WHERE.operation, 'refund.reservation-release')
  assert.ok(UNKNOWN_RELEASE_STATUS_ROW_WHERE.status.notIn.includes('SUCCEEDED'))
  assert.ok(!UNKNOWN_RELEASE_STATUS_ROW_WHERE.status.notIn.includes('QUARANTINED'))
})
