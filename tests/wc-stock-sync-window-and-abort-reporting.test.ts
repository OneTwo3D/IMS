import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyMappingPersistError, isPermanentWindowError, manualProgressErrors } from '@/lib/connectors/woocommerce/sync/stock-sync'

/**
 * o3d-hqvrp.101: a catalogue-shaped (permanent) error must not hold the daily reconcile window; a transient one still must.
 * o3d-jep7: a mid-run credentials-rebind abort is listed first on the manual sync screen, so 20+ per-item errors cannot truncate it away.
 */
test('permanent catalogue errors do not hold a reconcile window; transient ones do', () => {
  for (const message of [
    'lookup failure for SKU V-1: variant has no parent SKU in IMS; cannot resolve Woo variation id',
    'lookup failure for SKU V-2: ambiguous — WooCommerce returned 2+ variations sharing this SKU under parent P-1',
    'lookup failure for SKU P-9: ambiguous parent SKU P-9 — WooCommerce returned 2+ products',
    'KIT cycle detected: a -> b -> a',
    'externalProductId collision: could not persist 12 for IMS product x (SKU y): unique constraint',
  ]) assert.equal(isPermanentWindowError(message), true, message)
  for (const message of [
    'lookup failure for SKU V-1: HTTP 503',
    'batch push 3: timeout',
    'variation batch push 12: 500',
    'Failed to clear stale externalProductId for p1: x',
    'WooCommerce credentials were rebound mid-run — aborted 5 remaining push(es) to avoid pushing to a disconnected store',
  ]) assert.equal(isPermanentWindowError(message), false, message)
})

test('the rebind abort notice leads the 20 errors the manual screen shows', () => {
  const notice = 'WooCommerce credentials were rebound mid-run — aborted 40 remaining push(es) to avoid pushing to a disconnected store'
  const errors = [...Array.from({ length: 25 }, (_, i) => `batch push ${i}: failed`), notice]
  const shown = manualProgressErrors({ errors, abortedRemaining: 40, abortNotice: notice })
  assert.equal(shown.length, 20)
  assert.equal(shown[0], notice)
  assert.deepEqual(manualProgressErrors({ errors: ['a', 'b'] }), ['a', 'b'])
})

test('only a P2002 unique violation is a collision (permanent); timeouts and connection errors keep their message and hold the window', () => {
  const p2002 = Object.assign(new Error('Unique constraint failed on the fields: (`external_product_id`)'), { code: 'P2002' })
  const collision = classifyMappingPersistError(p2002)
  assert.equal(collision.reason, 'collision')
  assert.equal(isPermanentWindowError(`externalProductId collision: could not persist 1 for IMS product p (SKU s): ${collision.error}`), true)
  for (const code of ['P2024', 'P1001', 'P1017', 'P2034', undefined]) {
    const transient = classifyMappingPersistError(Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code }))
    assert.equal(transient.reason, 'error', String(code))
    // The call site words a non-collision error "mapping persist failed: ...", which must hold the window.
    assert.equal(isPermanentWindowError(`mapping persist failed: could not persist 1 for IMS product p (SKU s): ${transient.error}`), false, String(code))
  }
  assert.equal(classifyMappingPersistError('socket hang up').reason, 'error')
})
