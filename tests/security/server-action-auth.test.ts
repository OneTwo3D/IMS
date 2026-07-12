import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchShoppingProductLink } from '@/app/actions/shopping'
import { getMintsoftPurchaseOrderAsnState } from '@/app/actions/mintsoft-sync'

function rejectsAuthGate(error: unknown): boolean {
  const message = String(error)
  return (
    (message.includes('NEXT_REDIRECT') && message.includes('/login')) ||
    message.includes('Forbidden') ||
    message.includes('headers` was called outside a request scope')
  )
}

test('shopping product link server action rejects unauthenticated callers', async () => {
  await assert.rejects(() => fetchShoppingProductLink('SKU-1'), rejectsAuthGate)
})

test('mintsoft PO ASN-state server action rejects unauthenticated callers', async () => {
  // Regression: this read previously proceeded without an auth gate and
  // returned PO/warehouse/ASN metadata to any caller. It must now fail closed.
  await assert.rejects(() => getMintsoftPurchaseOrderAsnState('po_test'), rejectsAuthGate)
})
