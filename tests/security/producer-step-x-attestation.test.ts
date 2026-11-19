import assert from 'node:assert/strict'
import test from 'node:test'

import { explainProducerDisposition } from '../../lib/security/producer-disposition.ts'
import { producerOperationEgressVerdict } from '../../lib/security/producer-seam.ts'
import { attestationInForce, attestationState, resetAttestationSnapshotForTests, setAttestationSnapshot } from '../../lib/security/writer-attestation-snapshot.ts'
import { xeroRowDeliveryHold } from '../../lib/domain/accounting/xero-producer-seam.ts'

/**
 * STEP X (AND THE STEP-W STOCK PUSH) DELIVER ONLY ONCE THE OWNER HAS CONFIRMED THE INCUMBENT IS STOPPED, AND A MISSING CONFIRMATION HOLDS, NEVER SHADOWS (o3d-zvec.3).
 * This file does NOT import tests/helpers/xero-attested.ts.
 * Mutation: make the decision shadow on a missing confirmation again => the "never shadowed" arms go red. Drop the egress check => the held arms go red.
 */

const NOW = new Date('2026-12-20T00:00:00Z')
const AT = '2026-12-01T00:00:00Z'
const env = {
  XERO_WRITE_ALLOWED_TENANT: '4f7f0c6e-1111-4222-8333-944455556666', XERO_WRITES_LIVE_FROM: AT,
  WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: AT,
  MINTSOFT_WRITE_ALLOWED: 'https://api.example.test|89', MINTSOFT_WRITES_LIVE_FROM: AT,
  PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all',
}
const LATE = new Date('2026-12-10T00:00:00Z')
const STEP_X_ROWS = [['xero', 'purchase.bill'], ['xero', 'daily-batch'], ['xero', 'sales.payment'], ['woocommerce', 'order.invoice-note'], ['woocommerce', 'order.invoice-document']] as const

test('the decision NEVER shadows for a missing confirmation, in any of its three states: the work is produced (LIVE) and its delivery waits', () => {
  for (const state of ['unknown', 'absent', 'present'] as const) {
    resetAttestationSnapshotForTests()
    if (state === 'absent') setAttestationSnapshot(new Set())
    if (state === 'present') setAttestationSnapshot(new Set(['qoblex-xero-stopped', 'qoblex-stock-push-stopped']))
    for (const [destination, operation] of [...STEP_X_ROWS, ['woocommerce', 'stock']] as const) {
      const d = explainProducerDisposition(destination, operation as never, LATE, { env, now: NOW })
      assert.deepEqual([d.disposition, d.reason], ['LIVE', 'live'], `${state}: ${destination}.${operation}`)
    }
  }
  resetAttestationSnapshotForTests()
})

test('UNKNOWN (nothing read yet, or the read failed) HOLDS every step-X row and the step-W stock row: held, awaiting "unknown", never a shadow', () => {
  resetAttestationSnapshotForTests()
  for (const [destination, operation] of [...STEP_X_ROWS, ['woocommerce', 'stock']] as const) {
    const verdict = producerOperationEgressVerdict(destination, operation as never, { env, now: NOW })
    assert.equal(verdict.kind, 'held', `${destination}.${operation}`)
    assert.equal((verdict as { awaiting?: { state: string } }).awaiting?.state, 'unknown', `${destination}.${operation}`)
    assert.equal(verdict.kind === 'held' ? verdict.decision.reason : '', 'attestation_missing')
  }
  // The queued-row gate says the same, and says "hand it back unsent, spend nothing".
  const hold = xeroRowDeliveryHold({ type: 'PURCHASE_INVOICE', env, now: NOW })
  assert.ok(hold !== null && hold.awaiting === true)
  assert.ok(xeroRowDeliveryHold({ type: 'WC_INVOICE_NOTE', env, now: NOW })?.awaiting)
})

test('ABSENT (a positive read found no confirmation) also HOLDS, retryably: recording the confirmation opens the SAME operation with no other change', () => {
  resetAttestationSnapshotForTests()
  setAttestationSnapshot(new Set())
  const before = producerOperationEgressVerdict('xero', 'purchase.bill', { env, now: NOW })
  assert.equal(before.kind, 'held')
  assert.equal((before as { awaiting?: { state: string } }).awaiting?.state, 'absent')
  assert.equal(attestationState('qoblex-xero-stopped'), 'absent')
  setAttestationSnapshot(new Set(['qoblex-xero-stopped'])) // the owner records it
  assert.equal(producerOperationEgressVerdict('xero', 'purchase.bill', { env, now: NOW }).kind, 'open')
  assert.equal(xeroRowDeliveryHold({ type: 'PURCHASE_INVOICE', env, now: NOW }), null)
  assert.equal(xeroRowDeliveryHold({ type: 'WC_INVOICE_NOTE', env, now: NOW }), null)
  resetAttestationSnapshotForTests()
})

test('the confirmation is per kind: the Xero one does not open the stock push, the stock one does not open Xero; step M needs none', () => {
  resetAttestationSnapshotForTests()
  setAttestationSnapshot(new Set(['qoblex-xero-stopped']))
  assert.equal(producerOperationEgressVerdict('woocommerce', 'stock', { env, now: NOW }).kind, 'held', 'the stock push needs ITS OWN confirmation')
  assert.equal(producerOperationEgressVerdict('xero', 'purchase.bill', { env, now: NOW }).kind, 'open')
  setAttestationSnapshot(new Set(['qoblex-stock-push-stopped']))
  assert.equal(producerOperationEgressVerdict('woocommerce', 'stock', { env, now: NOW }).kind, 'open')
  assert.equal(producerOperationEgressVerdict('xero', 'purchase.bill', { env, now: NOW }).kind, 'held')
  assert.equal(producerOperationEgressVerdict('woocommerce', 'webhooks', { env, now: NOW }).kind, 'open', 'webhooks stay separate from the stock confirmation')
  resetAttestationSnapshotForTests()
  assert.equal(producerOperationEgressVerdict('mintsoft', 'order.create', { env, now: NOW }).kind, 'open', 'step M needs no confirmation, whatever is known')
  assert.equal(producerOperationEgressVerdict('woocommerce', 'order.status', { env, now: NOW }).kind, 'open')
})

test('a supplied set wins over the snapshot, and anything that is not a set reads as "absent" (held, never open)', () => {
  resetAttestationSnapshotForTests()
  assert.equal(producerOperationEgressVerdict('xero', 'purchase.bill', { env, now: NOW, attestations: new Set(['qoblex-xero-stopped']) }).kind, 'open')
  assert.equal(producerOperationEgressVerdict('xero', 'purchase.bill', { env, now: NOW, attestations: 'yes' as never }).kind, 'held')
  assert.equal(attestationInForce('qoblex-xero-stopped', new Set()), false)
  resetAttestationSnapshotForTests()
})

test('the hold is not enforced: legacy, nothing waits', () => {
  resetAttestationSnapshotForTests()
  assert.equal(producerOperationEgressVerdict('xero', 'purchase.bill', { env: { ...env, PRODUCER_HOLD_ENFORCED_DESTINATIONS: '' }, now: NOW }).kind, 'legacy')
  assert.equal(xeroRowDeliveryHold({ type: 'PURCHASE_INVOICE', env: { ...env, PRODUCER_HOLD_ENFORCED_DESTINATIONS: '' }, now: NOW }), null)
})
