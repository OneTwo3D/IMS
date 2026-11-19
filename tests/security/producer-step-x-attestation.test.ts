import assert from 'node:assert/strict'
import test from 'node:test'

import { explainProducerDisposition } from '../../lib/security/producer-disposition.ts'
import { PRODUCER_REASON_TEXT } from '../../lib/security/producer-disposition-constants.ts'
import { attestationInForce, setAttestationSnapshot } from '../../lib/security/writer-attestation-snapshot.ts'

/**
 * STEP X WRITES STAY HELD UNTIL THE OWNER HAS CONFIRMED QOBLEX'S XERO POSTING IS STOPPED (o3d-zvec.3).
 * This file does NOT import tests/helpers/xero-attested.ts. Mutation: drop the attestation check in the decision => the held arms go red.
 */

const NOW = new Date('2026-12-20T00:00:00Z')
const AT = '2026-12-01T00:00:00Z'
const env = {
  XERO_WRITE_ALLOWED_TENANT: '4f7f0c6e-1111-4222-8333-944455556666', XERO_WRITES_LIVE_FROM: AT,
  WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', MINTSOFT_WRITE_ALLOWED: 'https://api.example.test|89', MINTSOFT_WRITES_LIVE_FROM: AT,
}
const LATE = new Date('2026-12-10T00:00:00Z')

test('without the confirmation a step-X write is SHADOW with a reason that names the attestation; Xero and the WooCommerce note alike', () => {
  setAttestationSnapshot(null)
  for (const [destination, operation] of [['xero', 'purchase.bill'], ['xero', 'daily-batch'], ['xero', 'sales.payment'], ['woocommerce', 'order.invoice-note']] as const) {
    const d = explainProducerDisposition(destination, operation as never, LATE, { env, now: NOW })
    assert.deepEqual([d.disposition, d.reason], ['SHADOW', 'attestation_missing'], `${destination}.${operation}`)
  }
  assert.match(PRODUCER_REASON_TEXT.attestation_missing, /qoblex-xero-stopped/)
  setAttestationSnapshot(new Set(['qoblex-stock-push-stopped']))
  assert.equal(explainProducerDisposition('xero', 'purchase.bill', LATE, { env, now: NOW }).reason, 'attestation_missing', 'the OTHER confirmation does not unlock it')
})

test('with the confirmation (process snapshot or supplied set) the same writes are LIVE; steps M and W are not affected by it', () => {
  setAttestationSnapshot(new Set(['qoblex-xero-stopped']))
  assert.equal(explainProducerDisposition('xero', 'purchase.bill', LATE, { env, now: NOW }).disposition, 'LIVE')
  assert.equal(explainProducerDisposition('woocommerce', 'order.invoice-note', LATE, { env, now: NOW }).disposition, 'LIVE')
  setAttestationSnapshot(null)
  assert.equal(explainProducerDisposition('xero', 'purchase.bill', LATE, { env, now: NOW, attestations: new Set(['qoblex-xero-stopped']) }).disposition, 'LIVE', 'a supplied set wins over the snapshot')
  assert.equal(explainProducerDisposition('mintsoft', 'order.create', LATE, { env, now: NOW }).disposition, 'LIVE', 'step M needs no confirmation')
  assert.equal(explainProducerDisposition('woocommerce', 'order.status', LATE, { env, now: NOW }).disposition, 'LIVE', 'the bridge writeback is step M')
})

test('the snapshot fails closed: unloaded, empty and a throwing supplied value all read as not confirmed', () => {
  setAttestationSnapshot(null)
  assert.equal(attestationInForce('qoblex-xero-stopped'), false)
  setAttestationSnapshot(new Set())
  assert.equal(attestationInForce('qoblex-xero-stopped'), false)
  assert.equal(explainProducerDisposition('xero', 'purchase.bill', LATE, { env, now: NOW, attestations: 'yes' as never }).reason, 'attestation_missing')
})
