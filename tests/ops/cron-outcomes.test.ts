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
