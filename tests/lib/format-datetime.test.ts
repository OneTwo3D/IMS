import assert from 'node:assert/strict'
import test from 'node:test'

import { formatDateTime } from '@/lib/format-datetime'

// Pins Europe/London so SSR (UTC server) and client (browser TZ) render the
// SAME string — preventing the hydration mismatch. A summer UTC instant must
// come out as BST (+1), regardless of the host TZ this test runs under.
test('formatDateTime renders a UTC instant in Europe/London (BST in summer)', () => {
  const out = formatDateTime('2026-06-15T20:06:39Z')
  assert.match(out, /15\/06\/2026/)
  assert.match(out, /21:06:39/) // 20:06 UTC + 1h BST
})

test('formatDateTime is deterministic regardless of options/host TZ', () => {
  const out = formatDateTime('2026-01-15T09:30:00Z', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  // January → GMT (no offset)
  assert.match(out, /15 Jan/)
  assert.match(out, /09:30/)
})
