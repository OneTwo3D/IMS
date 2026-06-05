import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchShoppingProductLink } from '@/app/actions/shopping'

test('shopping product link server action rejects unauthenticated callers', async () => {
  await assert.rejects(
    () => fetchShoppingProductLink('SKU-1'),
    (error) => {
      const message = String(error)
      return (
        (message.includes('NEXT_REDIRECT') && message.includes('/login')) ||
        message.includes('headers` was called outside a request scope')
      )
    },
  )
})
