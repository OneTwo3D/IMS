import assert from 'node:assert/strict'
import test from 'node:test'

import { reconcileOneOrder, runWmsDispatchSweepCore, dispatchCandidateWhere, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsOrderStatus } from '../lib/connectors/wms/types.ts'

/**
 * A scoped despatch the order no longer matches (`wms_scope_mismatch`) is a condition a person fixes in IMS, not a connector failure: it must not count as a
 * dispatch error (so it never dead-letters the link and never feeds the systemic breaker), the link stays polled, the watermark is held, and a standing HIGH
 * refused action names it. Any other apply failure is an error, as before.
 */
const status: WmsOrderStatus = {
  externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: false,
  mergedOrderNumbers: [], deepLinkUrl: null, tracking: [{ trackingNumber: 'TN1', carrier: 'DPD', despatchedAt: '2026-08-19T10:00:00Z' }], dispatched: true, raw: null,
}

function deps(overrides: Partial<WmsDispatchSweepDeps>): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status,
    applyDispatch: async () => ({ success: true }),
    partsSupported: true,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }),
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((number) => [number, 1])),
    ...overrides,
  }
}

test('a scope mismatch is pending, not an error: nothing is counted against the link, a HIGH refusal is recorded', async () => {
  const errors: string[] = []
  const refusals: Array<{ gate: string; severity: string; permanence: string; action: string }> = []
  const { counters, logs } = await runWmsDispatchSweepCore(deps({
    applyDispatch: async () => ({ success: false, error: 'the units differ', refusal: 'wms_scope_mismatch' }),
    recordDispatchError: async (_candidate, reason) => { errors.push(reason); return { deadLettered: false } },
    recordRefusedAction: async (_candidate, refusal) => { refusals.push(refusal as never) },
  }))
  assert.deepEqual(errors, [], 'no dispatch failure is recorded, so it can never dead-letter or feed the breaker')
  assert.equal(counters.errors, 0)
  assert.equal(counters.dispatched, 0)
  assert.equal(refusals.length, 1)
  assert.deepEqual({ gate: refusals[0].gate, severity: refusals[0].severity, permanence: refusals[0].permanence, action: refusals[0].action }, { gate: 'WMS_SCOPE_MISMATCH', severity: 'HIGH', permanence: 'RETRYABLE', action: 'WMS_DESPATCH_SCOPE' })
  assert.equal(logs[0].action, 'pending')
})

test('any other apply failure is still an error (control)', async () => {
  const errors: string[] = []
  const { counters } = await runWmsDispatchSweepCore(deps({
    applyDispatch: async () => ({ success: false, error: 'boom', refusal: 'shipment_status_transition_failed' }),
    recordDispatchError: async (_candidate, reason) => { errors.push(reason); return { deadLettered: false } },
  }))
  assert.deepEqual(errors, ['boom'])
  assert.equal(counters.errors, 1)
})

test('the reconcile and probe selectors honour a settled link (source-level pin)', async () => {
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(new URL('../lib/domain/wms/dispatch-sweep.ts', import.meta.url), 'utf8')
  for (const name of ['async listReconcileCandidates', 'async probeControlLinks']) {
    const body = text.slice(text.indexOf(name), text.indexOf(name) + 1200)
    assert.match(body, /despatchSettledAt: null/, name)
  }
})

test('polling stops once the warehouse part is settled: the candidate query excludes a settled link', () => {
  assert.equal(dispatchCandidateWhere('mintsoft').despatchSettledAt, null)
})

test('the outcome does NOT hold the connector-wide delta watermark (one stuck order must never block the others)', async () => {
  const outcome = await reconcileOneOrder(deps({ applyDispatch: async () => ({ success: false, error: 'the units differ', refusal: 'wms_scope_mismatch' }) }), { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' })
  assert.equal(outcome.action, 'pending')
  assert.equal(outcome.holdWatermark, undefined)
  assert.equal(outcome.unresolved, undefined, 'not unresolved: no drift cohort, no quarantine')
})
