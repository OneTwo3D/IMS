import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markOrderDelivered } from '@/lib/trackship'

const INTERNAL_STATUS_TRANSITION_BYPASS_DESC = 'internal-status-transition-bypass'

function makeDeps(transitionResult: { success: boolean; error?: string }) {
  const calls: { transition: unknown[]; logs: Array<Record<string, unknown>> } = { transition: [], logs: [] }
  const deps = {
    transition: async (id: string, targetStatus: 'DELIVERED', extra: undefined, options: { internalBypassToken: symbol }) => {
      calls.transition.push({ id, targetStatus, extra, options })
      return transitionResult
    },
    log: async (entry: Record<string, unknown>) => { calls.logs.push(entry) },
  }
  return { deps: deps as never, calls }
}

test('routes delivery through the transition path with the bypass token (not a raw write)', async () => {
  const { deps, calls } = makeDeps({ success: true })
  const result = await markOrderDelivered(
    { id: 'so-1', externalOrderNumber: 'WC-100', source: 'trackship' },
    deps,
  )
  assert.equal(result.delivered, true)
  assert.equal(calls.transition.length, 1)
  const call = calls.transition[0] as { id: string; targetStatus: string; options: { internalBypassToken: symbol } }
  assert.equal(call.id, 'so-1')
  assert.equal(call.targetStatus, 'DELIVERED')
  // The bypass token is the symbol that lets the cron skip the permission check.
  assert.equal(typeof call.options.internalBypassToken, 'symbol')
  assert.equal(call.options.internalBypassToken.description, INTERNAL_STATUS_TRANSITION_BYPASS_DESC)
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
