import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'

// o3d-ahk: purgeExpiredData must hard-delete TERMINAL shopping-webhook-inbox rows (PROCESSED /
// DEAD_LETTER) past the retention cutoff, and never touch PENDING/FAILED (undelivered work).

let settingRows: Array<{ key: string; value: string }> = []
let webhookDeleteWhere: Record<string, unknown> | undefined
let webhookDeleteCount = 0

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
      setting: { findMany: async () => settingRows },
      shoppingSyncLog: noopDelegate(),
      accountingSyncLog: noopDelegate(),
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      shoppingWebhookEvent: {
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          webhookDeleteWhere = where
          return { count: webhookDeleteCount }
        },
      },
    },
  },
})

async function loadPurge() {
  return (await import('@/lib/data-retention')).purgeExpiredData
}

test('purges terminal webhook-inbox rows past the retention cutoff (o3d-ahk)', async () => {
  const purgeExpiredData = await loadPurge()
  settingRows = [{ key: 'retention_webhook_events_months', value: '3' }]
  webhookDeleteWhere = undefined
  webhookDeleteCount = 7

  const result = await purgeExpiredData()

  assert.equal(result.webhookEventsDeleted, 7)
  const status = (webhookDeleteWhere?.status as { in?: string[] })?.in ?? []
  assert.deepEqual(
    [...status].sort(),
    [WC_WEBHOOK_EVENT_STATUS.deadLetter, WC_WEBHOOK_EVENT_STATUS.processed].sort(),
  )
  // Never purges undelivered work.
  assert.ok(!status.includes(WC_WEBHOOK_EVENT_STATUS.pending))
  assert.ok(!status.includes(WC_WEBHOOK_EVENT_STATUS.failed))
  const updatedAt = webhookDeleteWhere?.updatedAt as { lt?: Date }
  assert.ok(updatedAt?.lt instanceof Date, 'bounded by an updatedAt cutoff')
})

test('a 0-month webhook retention setting disables the purge (keeps rows forever)', async () => {
  const purgeExpiredData = await loadPurge()
  settingRows = [{ key: 'retention_webhook_events_months', value: '0' }]
  webhookDeleteWhere = undefined
  webhookDeleteCount = 99

  const result = await purgeExpiredData()

  assert.equal(result.webhookEventsDeleted, 0)
  assert.equal(webhookDeleteWhere, undefined, 'deleteMany must not be called when retention is 0')
})
