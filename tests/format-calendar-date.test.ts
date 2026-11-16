import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCalendarDate, formatDateTime } from '@/lib/format-datetime'

// A delivery day is stored at UTC midnight. Formatting it in a zone west of UTC prints the previous day (the bug this guards);
// the calendar-date formatter must give the stored day whatever the server or organisation zone is.
const stored = new Date('2026-12-15T00:00:00.000Z')
const opts = { day: 'numeric', month: 'short', year: 'numeric' } as const

test('formatCalendarDate prints the stored calendar day with the process zone set west of UTC', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    assert.equal(formatCalendarDate(stored, opts), '15 Dec 2026')
    assert.equal(formatCalendarDate('2026-12-15T00:00:00.000Z', { day: 'numeric', month: 'long', year: 'numeric' }), '15 December 2026')
    // The old behaviour, for contrast: the organisation zone shifts the day.
    assert.equal(formatDateTime(stored, opts, 'America/New_York'), '14 Dec 2026')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('the supplier PO PDF renders header and line dates through formatCalendarDate, never the organisation zone', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../lib/purchase-order-pdf.ts', import.meta.url), 'utf8')
  assert.match(src, /Expected delivery: \$\{formatCalendarDate\(po\.expectedDelivery/)
  assert.match(src, /formatDate: \(d\) => formatCalendarDate\(d/)
  assert.doesNotMatch(src, /formatDateTime\(po\.expectedDelivery/)
})
