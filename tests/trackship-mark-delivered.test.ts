import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markOrderDelivered } from '@/lib/trackship'

type TransitionCall = {
  id: string
  targetStatus: string
  extra?: { trackingNumber?: string; shipFromWarehouseId?: string }
  options?: { skipPermissionCheck?: boolean }
}

function makeDeps(transitionResult: { success: boolean; error?: string }) {
  const calls: { transition: TransitionCall[]; logs: Array<Record<string, unknown>> } = { transition: [], logs: [] }
  const deps = {
    transition: async (
      id: string,
      targetStatus: 'DELIVERED',
      extra?: { trackingNumber?: string; shipFromWarehouseId?: string },
      options?: { skipPermissionCheck?: boolean },
    ) => {
      calls.transition.push({ id, targetStatus, extra, options })
      return transitionResult
    },
    log: async (entry: Record<string, unknown>) => { calls.logs.push(entry) },
  }
  return { deps, calls }
}

test('routes delivery through the transition path skipping only permission (not a raw write)', async () => {
  const { deps, calls } = makeDeps({ success: true })
  const result = await markOrderDelivered(
    { id: 'so-1', externalOrderNumber: 'WC-100', source: 'trackship' },
    deps,
  )
  assert.equal(result.delivered, true)
  assert.equal(calls.transition.length, 1)
  const call = calls.transition[0]
  assert.equal(call.id, 'so-1')
  assert.equal(call.targetStatus, 'DELIVERED')
  // skipPermissionCheck skips only the permission gate — the state-machine
  // guard still runs, so a since-cancelled order is rejected (success:false).
  assert.equal(call.options?.skipPermissionCheck, true)
  // Logs the successful delivery.
  assert.equal(calls.logs.length, 1)
  assert.equal(calls.logs[0].action, 'delivered')
})

test('skips and warns when the transition is rejected (order no longer SHIPPED)', async () => {
  const { deps, calls } = makeDeps({ success: false, error: 'Cannot move from CANCELLED to DELIVERED' })
  const result = await markOrderDelivered(
    { id: 'so-2', externalOrderNumber: 'WC-200', source: 'shopping_connector' },
    deps,
  )
  // Not counted as delivered, and no forced write — only a warning log.
  assert.equal(result.delivered, false)
  assert.equal(calls.transition.length, 1)
  assert.equal(calls.logs.length, 1)
  assert.equal(calls.logs[0].action, 'delivery_status_skipped')
  assert.equal(calls.logs[0].level, 'WARNING')
  assert.match(String(calls.logs[0].description), /Cannot move from CANCELLED to DELIVERED/)
})
