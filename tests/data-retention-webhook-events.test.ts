import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'

// o3d-ahk: purgeExpiredData COMPACTS succeeded shopping-webhook-inbox rows past the cutoff — it clears
// the bulky payloadJson but KEEPS the row (the connector/resource/payloadHash idempotency tombstone).
// DEAD_LETTER (unresolved) and PENDING/FAILED (undelivered) are left fully intact.

type UpdateArgs = { where: Record<string, unknown>; data: Record<string, unknown> }

const capture: { settingRows: Array<{ key: string; value: string }>; last?: UpdateArgs; count: number } = {
  settingRows: [],
  last: undefined,
  count: 0,
}

function noopDelegate() {
  return {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
  }
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findMany: async () => capture.settingRows },
      shoppingSyncLog: noopDelegate(),
      accountingSyncLog: noopDelegate(),
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      // q66in.7.4: the WMS retention passes added to purgeExpiredData run unconditionally on
      // their own defaults, so this harness has to answer for their delegates too. Inert here —
      // their behaviour is asserted in tests/data-retention-wms-events.test.ts.
      wmsInboundReceiptEvent: noopDelegate(),
      wmsWebhookEvent: noopDelegate(),
      wmsSyncJob: noopDelegate(),
      externalWmsBinding: noopDelegate(),
      shoppingWebhookEvent: {
        deleteMany: async () => {
          throw new Error('inbox rows must be COMPACTED, never deleted (dedup + audit)')
        },
        updateMany: async (args: UpdateArgs) => {
          capture.last = args
          return { count: capture.count }
        },
      },
    },
  },
})

async function loadPurge() {
  return (await import('@/lib/data-retention')).purgeExpiredData
}

test('compacts ONLY PROCESSED rows past the cutoff, clearing payloadJson but keeping the row (o3d-ahk)', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '3' }]
  capture.last = undefined
  capture.count = 7

  const result = await purgeExpiredData()

  assert.equal(result.webhookEventsCompacted, 7)
  if (!capture.last) throw new Error('updateMany was not called')
  const args: UpdateArgs = capture.last
  // Only succeeded rows — never DEAD_LETTER (audit) or PENDING/FAILED (undelivered).
  assert.equal(args.where.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.notEqual(args.where.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)
  assert.ok((args.where.updatedAt as { lt?: Date })?.lt instanceof Date, 'bounded by an updatedAt cutoff')
  // Already-compacted rows are permanently excluded so each run only touches the newly-eligible set.
  assert.deepEqual((args.where.NOT as { payloadJson?: { equals?: unknown } })?.payloadJson?.equals, {})
  // Clears the bulky payload, keeps the row (dedup key + status untouched).
  assert.deepEqual(args.data.payloadJson, {})
  assert.equal(args.data.lastError, null)
  assert.equal(args.data.status, undefined, 'status is preserved, not changed')
})

test('a 0-month webhook retention setting disables compaction', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '0' }]
  capture.last = undefined
  capture.count = 99

  const result = await purgeExpiredData()

  assert.equal(result.webhookEventsCompacted, 0)
  assert.equal(capture.last, undefined, 'updateMany must not be called when retention is 0')
})
