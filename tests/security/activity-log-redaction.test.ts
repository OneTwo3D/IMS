import assert from 'node:assert/strict'
import test from 'node:test'

import {
  redactActivityLogText,
  sanitizeActivityLogMetadata,
} from '@/lib/activity-log'

test('activity log text redacts tokens, secrets, passwords, and emails', () => {
  const redacted = redactActivityLogText(
    'Bearer abc.def token=tok_123 password=hunter2 secret:shh user jane@example.com',
  )

  assert.equal(redacted.includes('abc.def'), false)
  assert.equal(redacted.includes('tok_123'), false)
  assert.equal(redacted.includes('hunter2'), false)
  assert.equal(redacted.includes('shh'), false)
  assert.equal(redacted.includes('jane@example.com'), false)
  assert.match(redacted, /Bearer \[redacted\]/)
})

test('activity log metadata redacts sensitive keys recursively', () => {
  const redacted = sanitizeActivityLogMetadata({
    orderNumber: 'SO-1',
    password: 'hunter2',
    secret: 'shh',
    token: 'tok_456',
    error: 'request failed with access_token=tok_123',
    nested: {
      refreshToken: 'refresh-secret',
      customerEmail: 'customer@example.com',
    },
  }) as {
    orderNumber: string
    password: string
    secret: string
    token: string
    error: string
    nested: { refreshToken: string; customerEmail: string }
  }

  assert.equal(redacted.orderNumber, 'SO-1')
  assert.equal(redacted.password, '[redacted]')
  assert.equal(redacted.secret, '[redacted]')
  assert.equal(redacted.token, '[redacted]')
  assert.equal(redacted.error.includes('tok_123'), false)
  assert.equal(redacted.nested.refreshToken, '[redacted]')
  assert.equal(redacted.nested.customerEmail, '[redacted]')
})
