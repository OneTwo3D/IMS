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

/**
 * Round 2, finding 1 — THE SAME ARITHMETIC CONDEMNS THE AUTOMATIC PATH.
 *
 * Round 1 established the window and then reasoned only about the button a human presses. But six
 * minutes is not a fact about humans: the retries a WORKER schedules are minutes apart too, so the
 * "deterministic key, therefore safe" argument the automatic path is documented to rest on has never
 * held either. These compare the real constants rather than restating the claim — the day someone
 * shortens the backoff or lengthens the in-request retry budget, the prose above becomes false and
 * this is what says so.
 */
test('o3d-wahn r2: the only retry inside the window is the in-request 429 loop', async () => {
  const { XERO_MAX_RETRIES, XERO_MAX_RETRY_AFTER_MS } = await import('@/lib/connectors/xero/api')

  // Read from the connector, not restated here: a claim about a retry budget that does not read the
  // budget is a claim about nothing.
  assert.equal(typeof XERO_MAX_RETRIES, 'number', 'the in-request retry budget must be readable to be compared')
  assert.equal(typeof XERO_MAX_RETRY_AFTER_MS, 'number', 'and so must the longest wait per attempt')

  // Worst case for one API call: every attempt 429s and waits the longest we are willing to block.
  const worstCaseElapsedMs = XERO_MAX_RETRIES * XERO_MAX_RETRY_AFTER_MS
  assert.ok(
    worstCaseElapsedMs < XERO_IDEMPOTENCY_KEY_RETENTION_MS,
    `an in-request retry can take at most ${worstCaseElapsedMs}ms, which must stay inside the `
      + `${XERO_IDEMPOTENCY_KEY_RETENTION_MS}ms Xero keeps the key for — it re-sends the SAME header, so `
      + 'this is the one retry the key was designed for',
  )
})

test('o3d-wahn r2: a queued retry lands outside the window, so the key protects nothing there', async () => {
  const { DEFAULT_RETRY_BASE_DELAY_MS } = await import('@/lib/domain/integrations/outbox')

  // The first retry is scheduled a full backoff after the failure, and the failure is itself after the
  // call. Measured from the first call — which is where Xero measures from — that is already at the
  // line, with only a minute of slack that a slow request or a cron tick eats.
  assert.ok(
    DEFAULT_RETRY_BASE_DELAY_MS + 60_000 >= XERO_IDEMPOTENCY_KEY_RETENTION_MS,
    'the first automatic retry is not comfortably inside the window; it sits on the boundary',
  )
  // And the second is not arguable at all: the backoff doubles.
  assert.ok(
    DEFAULT_RETRY_BASE_DELAY_MS * 2 > XERO_IDEMPOTENCY_KEY_RETENTION_MS,
    'from the second automatic retry on, the key has certainly expired and the re-post is a NEW request',
  )
  assert.equal(
    isWithinXeroIdempotencyWindow(new Date(Date.now() - DEFAULT_RETRY_BASE_DELAY_MS * 2)),
    false,
    'stated the other way round: a row whose attempt was two backoffs ago is outside the window',
  )
})

test('o3d-wahn r2: the module says plainly what protects an automatic retry instead', () => {
  // The obligation this round is honesty, and the deliverable is prose — so the prose is the thing
  // under test. It must name the local record (the real protection), and must not leave the reader
  // with a remote guarantee that expired before the retry was scheduled.
  const source = readFileSync(new URL('../../lib/domain/accounting/idempotency-retention.ts', import.meta.url), 'utf8')
  assert.match(source, /AUTOMATIC PATH IS NO BETTER/,
    'the automatic path is addressed, not just the button an operator presses')
  assert.match(source, /externalTransactionId/,
    'and points at the local record that actually short-circuits the next attempt')
  assert.match(source, /NOTHING[\s*]+PREVENTS the duplicate/,
    'and says plainly that once that record is lost nothing prevents the duplicate')
  assert.match(source, /settlement-status\.ts|settlementStatus/,
    'naming the detective control that is left, rather than implying a preventive one')
})

test('o3d-wahn r2: the runbook covers the automatic retries too', () => {
  const doc = readFileSync(new URL('../../help-docs/xero-sync.md', import.meta.url), 'utf8')
  assert.match(doc, /The same is true of the AUTOMATIC retries/,
    'an operator reading only the runbook must not think the queue is protected while the button is not')
  assert.match(doc, /update-or-create on `InvoiceNumber`/,
    'and it distinguishes the one operation that IS protected, by Xero\'s semantics rather than by the key')
  assert.match(doc, /nothing\s+prevents a duplicate/i,
    'and states the unprotected case rather than leaving it to be inferred')
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
