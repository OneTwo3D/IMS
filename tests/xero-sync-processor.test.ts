import assert from 'node:assert/strict'
import test from 'node:test'

import { isXeroAccountingOutboxEnabled } from '@/lib/connectors/xero/sync-processor'

test('Xero accounting outbox processor feature flag defaults on', () => {
  assert.equal(isXeroAccountingOutboxEnabled(undefined), true)
  assert.equal(isXeroAccountingOutboxEnabled(''), true)
  assert.equal(isXeroAccountingOutboxEnabled('true'), true)
})

test('Xero accounting outbox processor feature flag accepts rollback values', () => {
  assert.equal(isXeroAccountingOutboxEnabled('false'), false)
  assert.equal(isXeroAccountingOutboxEnabled('0'), false)
  assert.equal(isXeroAccountingOutboxEnabled(' off '), false)
})
