import assert from 'node:assert/strict'
import test from 'node:test'

import { formatIfModifiedSince } from '@/lib/connectors/xero/api'

// Xero documents `yyyy-mm-ddThh:mm:ss` for If-Modified-Since and ignores the header when it does
// not get that. Ignored means "every record comes back", which looks like working code and is what
// `ModifiedAfter=` did for months (o3d-5gm) — so the format is worth pinning.

test('formats to whole seconds, no milliseconds, no offset', () => {
  assert.equal(formatIfModifiedSince(new Date('2026-07-17T12:34:56.789Z')), '2026-07-17T12:34:56')
})

test('accepts an ISO string as well as a Date', () => {
  assert.equal(formatIfModifiedSince('2026-07-17T12:34:56.789Z'), '2026-07-17T12:34:56')
})

test('a non-UTC input is normalised to UTC', () => {
  // +02:00 local is 10:34:56Z. Sending the local wall-clock reading would shift the window two
  // hours the wrong way and skip real records.
  assert.equal(formatIfModifiedSince('2026-07-17T12:34:56+02:00'), '2026-07-17T10:34:56')
})

test('sub-second is truncated DOWN, never rounded up', () => {
  // Rounding up could push the floor past a record modified in that same second and lose it for
  // good. An earlier floor only costs a re-read the callers already treat as a no-op.
  assert.equal(formatIfModifiedSince(new Date('2026-07-17T12:34:56.999Z')), '2026-07-17T12:34:56')
})

test('never emits the millisecond/offset shape the SDK bug reports blame', () => {
  const out = formatIfModifiedSince(new Date('2026-07-17T12:34:56.789Z'))
  assert.equal(out.includes('.'), false, 'milliseconds present')
  assert.equal(out.endsWith('Z'), false, 'Z suffix present')
  assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
})
