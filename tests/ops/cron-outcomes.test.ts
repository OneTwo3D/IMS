import assert from 'node:assert/strict'
import test from 'node:test'

import { cronOutcome, worstOutcome } from '../../lib/ops/cron-outcomes.ts'
import { OutboundWriteHeldError } from '../../lib/security/outbound-write-grant.ts'

process.env.SETTINGS_ENCRYPTION_KEY ||= 'a'.repeat(64)

const heldText = new OutboundWriteHeldError(
  { connector: 'woocommerce', code: 'no_grant', method: 'PUT', target: 'https://shop.example.test/wp-json/wc/v3/products/1', granted: null, attempted: null, basis: 'test' },
  0,
).message

test('worstOutcome: failed over held over ok over skipped', () => {
  assert.equal(worstOutcome('ok', 'held', 'skipped'), 'held')
  assert.equal(worstOutcome('held', 'failed'), 'failed')
  assert.equal(worstOutcome('skipped', 'skipped'), 'skipped')
  assert.equal(worstOutcome(), 'skipped')
})

test('numeric failure counts: a count above the held count is a failure, equal to it is held, zero is ok', () => {
  assert.equal(cronOutcome('hs-classify', { scanned: 3, proposed: 3, errors: 0 }), 'ok')
  assert.equal(cronOutcome('hs-classify', { scanned: 3, proposed: 2, errors: 1 }), 'failed')
  assert.equal(cronOutcome('wms-order-status', { scanned: 3, updated: 2, failed: 1 }), 'failed')
  assert.equal(cronOutcome('wms-order-status', { skipped: 'No WMS connector is enabled', scanned: 0, updated: 0, failed: 0 }), 'skipped')
  assert.equal(cronOutcome('refund-reservation-release', {
    release: { claimed: 2, succeeded: 2, failed: 0 },
    unmatchedWarnings: { claimed: 1, succeeded: 0, failed: 1 },
  }), 'failed')
  assert.equal(cronOutcome('email-outbox', { processed: 1, sent: 0, failed: 1, parked: 0 } as never), 'failed')
  assert.equal(cronOutcome('accounting-sync', { processed: 2, succeeded: 0, failed: 2, skipped: 0, outboundHeld: 2 } as never), 'held')
  assert.equal(cronOutcome('accounting-sync', { processed: 2, succeeded: 0, failed: 2, skipped: 0, outboundHeld: 1 } as never), 'failed')
})

test('text failures: a hold text is held, a held text beside a real one is failed, in every section', () => {
  assert.equal(cronOutcome('wc-reconcile', { orders: { synced: 1 }, queued: { processed: 1, failed: 1, errors: [heldText] } }), 'held')
  assert.equal(cronOutcome('wc-reconcile', { orders: { error: 'Initial order import has not been completed yet' }, queued: { errors: [heldText] } }), 'failed')
  assert.equal(cronOutcome('shopping-webhook-inbox', { connectors: { woocommerce: { failed: 0, orderCompletions: { claimed: 0, errors: [] } } } }), 'ok')
  assert.equal(cronOutcome('shopping-webhook-inbox', { connectors: { woocommerce: { attempted: 0, processed: 0, failed: 1, error: 'boom' } } }), 'failed')
  assert.equal(cronOutcome('shopping-webhook-inbox', { connectors: { woocommerce: { skipped: true, reason: 'wc_sync_disabled' } } }), 'ok')
})

test('each route-owned signal: status enums, success flags, error keys', () => {
  assert.equal(cronOutcome('writers-check', { status: 'FAILED' }), 'failed')
  assert.equal(cronOutcome('writers-check', { status: 'OK' }), 'ok')
  assert.equal(cronOutcome('read-sync-liveness', { status: 'FAILED' }), 'failed')
  assert.equal(cronOutcome('wms-watchdog', { status: 'FAILED', overdueAsnAlerts: 0, staleBindingAlerts: 0 }), 'failed')
  assert.equal(cronOutcome('wms-watchdog', { status: 'SUCCEEDED', overdueAsnAlerts: 0, staleBindingAlerts: 0 }), 'ok')
  assert.equal(cronOutcome('accounting-fx-revaluation', { success: false }), 'failed')
  assert.equal(cronOutcome('backup', { filename: 'a', uploaded: false, deleted: 0 }), 'ok')
  assert.equal(cronOutcome('backup', { error: 'disk full' }), 'failed')
  assert.equal(cronOutcome('invariant-check', { status: 'completed' }), 'ok')
  assert.equal(cronOutcome('invariant-check', { status: 'failed' }), 'failed')
  assert.equal(cronOutcome('reconciliation-pack', { status: 'failed', recorded: true }), 'failed')
  assert.equal(cronOutcome('reconciliation-pack', { status: 'completed', recorded: false }), 'failed')
  assert.equal(cronOutcome('reconciliation-pack', { status: 'skipped', recorded: true }), 'skipped')
  assert.equal(cronOutcome('xero-chart-sync', { errors: ['x'] }), 'failed')
  assert.equal(cronOutcome('xero-chart-sync', { skipped: true }), 'skipped')
  assert.equal(cronOutcome('mintsoft-bundle-verify', { status: 'PARTIAL', totalChecked: 1, synced: 0, conflicts: 0, skipped: 0, errors: 1 }), 'failed')
  assert.equal(cronOutcome('mintsoft-product-verify', { jobId: null, status: 'SKIPPED', totalChecked: 0, matched: 0, mismatched: 0, corrected: 0, skipped: 0, errors: 0 }), 'skipped')
  assert.equal(cronOutcome('invoice-documents', { stoppedEarly: 'x', stored: 0, failed: 2 }), 'failed')
  assert.equal(cronOutcome('invoice-documents', { stoppedEarly: undefined, stored: 3, failed: 1 }), 'ok')
})

test('wc-reconcile: permanent import conflicts with an empty errors list are a failure', () => {
  const conflicts = { synced: 3, skipped: 0, errors: [], permanentErrors: ['SKU A-1: duplicate SKU in WooCommerce'] }
  assert.equal(cronOutcome('wc-reconcile', { products: conflicts }), 'failed')
  assert.equal(cronOutcome('wc-reconcile', { products: { ...conflicts, permanentErrors: [] } }), 'ok')
  assert.equal(cronOutcome('wc-reconcile', { skipped: true, reason: 'WC sync disabled' }), 'skipped')
})

test('email-outbox: parked, conflicted and unresolved-after-send rows are failures, an idle run is not', () => {
  const base = { processed: 0, sent: 0, failed: 0, parked: 0, conflicted: 0, conflictedWithoutSend: 0, unresolvedAfterSend: 0 }
  assert.equal(cronOutcome('email-outbox', base as never), 'ok')
  for (const key of ['parked', 'conflicted', 'conflictedWithoutSend', 'unresolvedAfterSend', 'failed']) {
    assert.equal(cronOutcome('email-outbox', { ...base, [key]: 1 } as never), 'failed', key)
  }
})

test('outboundHeld is subtracted only from the counter it is part of', () => {
  const base = { created: 0, verified: 0, verifyQuarantined: 0, verifyUnresolved: 0, updated: 0, cancelled: 0, held: 0, released: 0, failed: 0, deadLettered: 0, validationFailed: 0, revalidated: 0, revalidateAmbiguous: 0, createClaimParked: 0, ambiguousCreateRequeued: 0 }
  assert.equal(cronOutcome('wms-order-push', { ...base, failed: 1, outboundHeld: 1 }), 'held')
  assert.equal(cronOutcome('wms-order-push', { ...base, failed: 1, deadLettered: 1, outboundHeld: 1 }), 'failed')
  assert.equal(cronOutcome('wms-order-push', { ...base, deadLettered: 1, outboundHeld: 1 }), 'failed')
  assert.equal(cronOutcome('email-outbox', { processed: 1, sent: 0, failed: 1, parked: 1, conflicted: 0, conflictedWithoutSend: 0, unresolvedAfterSend: 0, outboundHeld: 1 } as never), 'failed')
  // the status-enum sweeps pair it with `errors`
  assert.equal(cronOutcome('mintsoft-dispatch-sync', { jobId: 'j', status: 'PARTIAL', totalChecked: 1, dispatched: 0, pending: 0, errors: 1, outboundHeld: 1 }), 'held')
  assert.equal(cronOutcome('accounting-sync', { processed: 2, succeeded: 0, failed: 1, skipped: 0, outboundHeld: 1, unmatched: { failed: 1 } } as never), 'failed')
})

test('accounting-daily-batch: lock contention is skipped by design, a real batch error is a failure', () => {
  const base = { groupA1: 0, groupA2: 0, groupB: 0, batchLimit: 50, hasMore: { A1: false, A2: false, B: false }, errors: [] as string[] }
  assert.equal(cronOutcome('accounting-daily-batch', { ...base, skipped: true, reason: 'already-running' } as never), 'skipped')
  assert.equal(cronOutcome('accounting-daily-batch', { ...base, errors: ['Journal rejected'] } as never), 'failed')
  assert.equal(cronOutcome('accounting-daily-batch', base as never), 'ok')
})
