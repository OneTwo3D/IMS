import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { cronOutcome as typedOutcome, type CronOutcomeSlug } from '../../lib/ops/cron-outcomes.ts'

const cronOutcome = (slug: CronOutcomeSlug, result: unknown) => typedOutcome(slug, result as never)
import { OutboundWriteHeldError } from '../../lib/security/outbound-write-grant.ts'

/**
 * A write the outbound-write hold refused must be counted in `outboundHeld` wherever a producer also counts it as failed, on every path
 * (main, retry, catch, follow-up), so the cron exit status can tell a held-only run (200) from one with a genuine failure (500).
 */

process.env.SETTINGS_ENCRYPTION_KEY ||= 'a'.repeat(64)

mock.module('@/lib/db', { namedExports: { db: {} } })

const refusal = (hop = 0) => new OutboundWriteHeldError(
  { connector: 'xero', code: 'no_grant', method: 'POST', target: 'https://api.xero.example.test/Invoices', granted: null, attempted: null, basis: 'test' },
  hop,
)

test('noteHeldFailure counts a thrown hold, the hold text and the wrapped hold text, and nothing else', async () => {
  const { noteHeldFailure } = await import('../../lib/connectors/xero/sync-processor.ts')
  const result = { processed: 0, succeeded: 0, failed: 0, skipped: 0 } as { processed: number; succeeded: number; failed: number; skipped: number; outboundHeld?: number }
  noteHeldFailure(result, refusal())
  noteHeldFailure(result, refusal().message)
  noteHeldFailure(result, `Xero rejected the invoice: ${refusal().message}`)
  assert.equal(result.outboundHeld, 3)
  noteHeldFailure(result, new Error('Xero said 400'))
  noteHeldFailure(result, 'Outbound write HELD (xero): forged, no reference')
  noteHeldFailure(result, refusal(1)) // the first request was already sent: not a pure hold
  assert.equal(result.outboundHeld, 3)
})

test('accounting-sync through the default outbox result: held only is 200, held beside a genuine failure is 500', async () => {
  const { noteHeldFailure } = await import('../../lib/connectors/xero/sync-processor.ts')
  const fail = (result: { failed: number; outboundHeld?: number }, error: unknown) => { result.failed++; noteHeldFailure(result as never, error) }

  const heldOnly = { processed: 2, succeeded: 0, failed: 0, skipped: 0 } as { processed: number; succeeded: number; failed: number; skipped: number; outboundHeld?: number }
  fail(heldOnly, String(refusal())) // the catch path (String(e))
  fail(heldOnly, refusal().message) // the retry path
  assert.equal(cronOutcome('accounting-sync', heldOnly), 'held')

  const mixed = { ...heldOnly, failed: 0, outboundHeld: undefined }
  fail(mixed, refusal().message)
  fail(mixed, 'Xero said 400')
  assert.equal(cronOutcome('accounting-sync', mixed), 'failed')
})

test('the mapping keeps held-only 2xx and mixed 5xx for the producers that report outboundHeld', () => {
  const base = { totalChecked: 3, matched: 0, mismatched: 0, corrected: 0, skipped: 0 }
  assert.equal(cronOutcome('mintsoft-product-verify', { ...base, jobId: 'j', status: 'PARTIAL', errors: 2, outboundHeld: 2 }), 'held')
  assert.equal(cronOutcome('mintsoft-product-verify', { ...base, jobId: 'j', status: 'PARTIAL', errors: 3, outboundHeld: 2 }), 'failed')
  assert.equal(cronOutcome('mintsoft-bundle-verify', { status: 'FAILED', totalChecked: 1, synced: 0, conflicts: 0, skipped: 0, errors: 1, outboundHeld: 1 }), 'held')
  assert.equal(cronOutcome('mintsoft-bundle-verify', { status: 'PARTIAL', totalChecked: 2, synced: 1, conflicts: 0, skipped: 0, errors: 1 }), 'failed')
})
