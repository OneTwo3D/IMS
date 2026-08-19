import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  accountingRetryDuplicateCaution,
  isWithinXeroIdempotencyWindow,
  XERO_IDEMPOTENCY_KEY_RETENTION_MS,
  XERO_IDEMPOTENCY_RETENTION_DOC_URL,
} from '../../lib/domain/accounting/idempotency-retention.ts'

/**
 * o3d-wahn: the window was never established, so "re-queueing is safe because the key is
 * deterministic" was an argument with a missing premise. It is established now, and it is SIX
 * MINUTES — short enough that the conclusion does not follow for any manual retry.
 */

test('o3d-wahn: Xero keeps an idempotency key for six minutes, which is the whole finding', () => {
  assert.equal(XERO_IDEMPOTENCY_KEY_RETENTION_MS, 6 * 60 * 1000,
    'the vendor documentation says "keys are stored for 6 minutes from the time of the first call"')
  assert.match(XERO_IDEMPOTENCY_RETENTION_DOC_URL, /^https:\/\/developer\.xero\.com\//,
    'and the claim cites where it came from, so it can be re-checked rather than trusted')
})

test('o3d-wahn: the window is measured from the attempt, and closes exactly on the bound', () => {
  const now = new Date('2026-08-19T12:00:00.000Z')
  const at = (msAgo: number) => new Date(now.getTime() - msAgo)

  assert.equal(isWithinXeroIdempotencyWindow(at(0), now), true, 'an attempt this instant')
  assert.equal(isWithinXeroIdempotencyWindow(at(XERO_IDEMPOTENCY_KEY_RETENTION_MS - 1), now), true,
    'one millisecond inside the window')
  assert.equal(isWithinXeroIdempotencyWindow(at(XERO_IDEMPOTENCY_KEY_RETENTION_MS), now), false,
    'and on the bound the key is gone — the boundary is not "about six minutes"')
  assert.equal(isWithinXeroIdempotencyWindow(at(60 * 60 * 1000), now), false, 'an hour-old row, which is the ordinary case')
})

test('o3d-wahn: an unknown attempt time is OUTSIDE the window, never inside it', () => {
  // "We do not know when this was posted" must not read as "it is safe to post again". A row with no
  // processingStartedAt has no attempt to be idempotent about.
  const now = new Date('2026-08-19T12:00:00.000Z')
  assert.equal(isWithinXeroIdempotencyWindow(null, now), false)
  assert.equal(isWithinXeroIdempotencyWindow(undefined, now), false)
  assert.equal(isWithinXeroIdempotencyWindow('not a date', now), false)
  assert.equal(isWithinXeroIdempotencyWindow(new Date(now.getTime() + 1000), now), false,
    'and a stamp in the future is a broken clock, not a fresh key')
})

test('o3d-wahn: the caution is offered for Xero and WITHHELD where no window was established', () => {
  const xero = accountingRetryDuplicateCaution('xero')
  assert.ok(xero, 'the Xero retry controls say what a retry costs')
  assert.match(xero!, /6 minutes/, 'and quote the window rather than gesturing at "may create duplicates"')
  assert.match(xero!, /SECOND document/, 'naming the actual consequence in the ledger')
  assert.match(xero!, /Check Xero/, 'and the check the operator has to make instead')

  // QuickBooks' RequestId window is unverified. A caution quoting an invented number would be worse
  // than none, because it would be believed.
  assert.equal(accountingRetryDuplicateCaution('quickbooks'), null)
  assert.equal(accountingRetryDuplicateCaution(null), null)
  assert.equal(accountingRetryDuplicateCaution(undefined), null)
})

test('o3d-wahn: the operator documentation records the same window as the code', () => {
  // The constant and the runbook are two statements of one fact, and the fact is the deliverable here.
  const doc = readFileSync(new URL('../../help-docs/xero-sync.md', import.meta.url), 'utf8')
  assert.match(doc, /stored for 6\n?> ?minutes|stored for 6 minutes/,
    'the vendor sentence is quoted, so a reader can see it is not our estimate')
  assert.ok(doc.includes(XERO_IDEMPOTENCY_RETENTION_DOC_URL.replace(/\/$/, '')),
    'and links the page it came from')
  assert.match(doc, /manual retry is therefore a new request/i,
    'and states the consequence for the control the operator actually presses')
})
